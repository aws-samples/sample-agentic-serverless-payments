const { Hono } = require('hono');
const { handle } = require('hono/aws-lambda');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
//const { generateJwt } = require('@coinbase/cdp-sdk/auth');
const https = require('https');

// Initialize outside handler for connection reuse
const app = new Hono();
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

// x402 v2 Configuration
// Use the canonical facilitator host (www.x402.org). The apex x402.org 308-redirects
// every request to www, so pointing here avoids an extra round-trip per verify/settle.
const X402_CONFIG = {
  facilitatorHost: 'www.x402.org',
  facilitatorBasePath: '/facilitator',
  usdcBase: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  network: 'eip155:84532', // Base Sepolia in CAIP-2 form (required by x402 v2)
  scheme: 'exact'
};

const X402_VERSION = 2;

// Build the v2 PaymentRequirements the seller expects for a given authorized amount.
const buildPaymentRequirements = (amount) => ({
  scheme: X402_CONFIG.scheme,
  network: X402_CONFIG.network,
  amount: String(amount),
  asset: X402_CONFIG.usdcBase,
  payTo: process.env.SELLER_WALLET_ADDRESS,
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' }
});

// `accepted` (sent inside the payment payload to the facilitator) mirrors the requirements
// without the EIP-712 `extra` metadata.
const toAccepted = (paymentRequirements) => {
  const { extra, ...accepted } = paymentRequirements;
  return accepted;
};

// Idempotency cache - for production, persist to DynamoDB for multi-instance scalability
const processedPayments = new Map();

// Add CORS middleware
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, PAYMENT-SIGNATURE');
  c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  
  if (c.req.method === 'OPTIONS') {
    return c.text('', 200);
  }
  
  await next();
});

// JWT generation for CDP facilitator (mainnet use)
// Currently using x402.org facilitator for Base Sepolia testnet which requires no authentication.
// For mainnet deployment with CDP facilitator, uncomment this function and update verify/settle
// functions to use CDP API endpoints (https://api.cdp.coinbase.com/platform/v2/x402/*)
// with JWT authentication in the Authorization header.
/*
const generateCDPJWT = async (requestMethod, requestPath) => {
  const keyName = process.env.CDP_API_KEY_NAME;
  const keySecret = process.env.CDP_API_KEY_SECRET;
  
  if (!keyName || !keySecret) {
    throw new Error('CDP API credentials not configured');
  }
  
  return await generateJwt({
    apiKeyId: keyName,
    apiKeySecret: keySecret,
    requestMethod: requestMethod,
    requestHost: 'api.cdp.coinbase.com',
    requestPath: requestPath,
    expiresIn: 120
  });
};
*/

// Helper function to get estimate from estimator Lambda (returns USDC wei)
const getEstimateFromLambda = async (content, model) => {
  const payload = { body: JSON.stringify({ content, model }) };
  const command = new InvokeCommand({
    FunctionName: process.env.ESTIMATOR_LAMBDA_NAME,
    Payload: JSON.stringify(payload)
  });

  const response = await lambdaClient.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.Payload));
  
  if (result.statusCode !== 200) {
    throw new Error('Estimator failed');
  }
  
  const body = JSON.parse(result.body);
  return body.totalCost;
};

// Verify payment with x402.org facilitator (x402 v2 wire format)
const verifyPayment = async (paymentPayload, paymentRequirements) => {
  const requestBody = {
    x402Version: X402_VERSION,
    paymentPayload: {
      x402Version: X402_VERSION,
      accepted: toAccepted(paymentRequirements),
      payload: paymentPayload
    },
    paymentRequirements
  };

  console.log('=== VERIFY REQUEST ===');
  console.log(`URL: https://${X402_CONFIG.facilitatorHost}${X402_CONFIG.facilitatorBasePath}/verify`);

  const bodyString = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: X402_CONFIG.facilitatorHost,
      port: 443,
      path: `${X402_CONFIG.facilitatorBasePath}/verify`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyString)
      }
    };
    
    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const redirectUrl = new URL(res.headers.location);
        const redirectReq = https.request({
          hostname: redirectUrl.hostname,
          port: redirectUrl.port || 443,
          path: redirectUrl.pathname + redirectUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyString)
          }
        }, (redirectRes) => {
          let data = '';
          redirectRes.on('data', (chunk) => data += chunk);
          redirectRes.on('end', () => {
            console.log('Verify response status:', redirectRes.statusCode);
            console.log('Verify raw response:', data);
            try {
              const result = JSON.parse(data);
              console.log('Is valid:', result.isValid);
              if (result.invalidReason) console.log('Invalid reason:', result.invalidReason);
              resolve(result);
            } catch (e) {
              reject(new Error(`Failed to parse response: ${data}`));
            }
          });
        });
        redirectReq.on('error', (e) => reject(e));
        redirectReq.write(bodyString);
        redirectReq.end();
        return;
      }
      
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log('Verify response status:', res.statusCode);
        console.log('Verify raw response:', data);
        try {
          const result = JSON.parse(data);
          console.log('Is valid:', result.isValid);
          if (result.invalidReason) console.log('Invalid reason:', result.invalidReason);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    
    req.on('error', (e) => reject(e));
    req.write(bodyString);
    req.end();
  });
};

// Settle payment with x402.org facilitator (x402 v2 wire format)
const settlePayment = async (paymentPayload, paymentRequirements) => {
  const requestBody = {
    x402Version: X402_VERSION,
    paymentPayload: {
      x402Version: X402_VERSION,
      accepted: toAccepted(paymentRequirements),
      payload: paymentPayload
    },
    paymentRequirements
  };

  console.log('=== SETTLE REQUEST ===');
  console.log(`URL: https://${X402_CONFIG.facilitatorHost}${X402_CONFIG.facilitatorBasePath}/settle`);

  const bodyString = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: X402_CONFIG.facilitatorHost,
      port: 443,
      path: `${X402_CONFIG.facilitatorBasePath}/settle`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyString)
      }
    };
    
    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const redirectUrl = new URL(res.headers.location);
        const redirectReq = https.request({
          hostname: redirectUrl.hostname,
          port: redirectUrl.port || 443,
          path: redirectUrl.pathname + redirectUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyString)
          }
        }, (redirectRes) => {
          let data = '';
          redirectRes.on('data', (chunk) => data += chunk);
          redirectRes.on('end', () => {
            console.log('Settle response status:', redirectRes.statusCode);
            console.log('Settle raw response:', data);
            try {
              const result = JSON.parse(data);
              resolve(result);
            } catch (e) {
              reject(new Error(`Failed to parse response: ${data}`));
            }
          });
        });
        redirectReq.on('error', (e) => reject(e));
        redirectReq.write(bodyString);
        redirectReq.end();
        return;
      }
      
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log('Settle response status:', res.statusCode);
        console.log('Settle raw response:', data);
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    
    req.on('error', (e) => reject(e));
    req.write(bodyString);
    req.end();
  });
};

// Helper function to call Bedrock Lambda
const callBedrockLambda = async (content, model) => {
  const payload = { body: JSON.stringify({ content, model, architecture: 'serverless' }) };
  const command = new InvokeCommand({
    FunctionName: process.env.BEDROCK_LAMBDA_NAME,
    Payload: JSON.stringify(payload)
  });

  const response = await lambdaClient.send(command);
  const result = JSON.parse(new TextDecoder().decode(response.Payload));
  
  if (result.statusCode !== 200 && result.statusCode !== 202) {
    throw new Error(`Bedrock failed: ${result.statusCode}`);
  }
  
  return JSON.parse(result.body);
};

// x402 compliant payment middleware for /generate route
app.use('/generate', async (c, next) => {
  try {
    const body = await c.req.json();
    const { content = '', model = 'nova-llm', price } = body;
    
    // Only estimate if price not provided
    const estimatedCost = price || await getEstimateFromLambda(content, model);
    
    // x402 v2: client sends the signed payment in the PAYMENT-SIGNATURE header.
    const paymentSignature = c.req.header('PAYMENT-SIGNATURE');
    const resourceUrl = `${process.env.API_GATEWAY_HTTP_URL}/generate`;

    if (!paymentSignature) {
      const paymentRequirements = buildPaymentRequirements(estimatedCost);
      // x402 v2: resource metadata is hoisted to the top level of the 402 body.
      const x402Response = {
        x402Version: X402_VERSION,
        accepts: [paymentRequirements],
        resource: {
          url: resourceUrl,
          description: `AI content generation with ${model}`,
          mimeType: 'application/json'
        },
        error: 'Payment required'
      };
      console.log('=== 402 RESPONSE ===');
      console.log(JSON.stringify(x402Response, null, 2));
      // x402 v2: PAYMENT-REQUIRED header with Base64-encoded payment requirements.
      c.header('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(x402Response)).toString('base64'));
      return c.json(x402Response, 402);
    }

    // Parse the Base64-encoded v2 PaymentPayload: { x402Version, payload: { signature, authorization }, accepted }
    let paymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentSignature, 'base64').toString('utf-8'));
    } catch (error) {
      return c.json({ error: 'Invalid payment payload' }, 400);
    }

    // Extract value from the authorization to ensure consistency
    const authorization = paymentPayload.payload?.authorization;
    const authorizedValue = authorization?.value;
    if (!authorizedValue) {
      return c.json({ error: 'Missing authorization value' }, 400);
    }

    // Idempotency check using nonce
    const nonce = authorization?.nonce;
    if (nonce && processedPayments.has(nonce)) {
      return c.json({ error: 'Payment already processed' }, 409);
    }

    // Rebuild payment requirements using the EXACT value from the authorization (the seller
    // is the source of truth, not the client's `accepted` copy).
    const paymentRequirements = buildPaymentRequirements(authorizedValue);

    console.log('=== PAYMENT VERIFICATION ===');
    console.log('Payment requirements:', JSON.stringify(paymentRequirements, null, 2));
    console.log('Payment payload from client:', JSON.stringify(paymentPayload, null, 2));
    console.log('Authorization value:', authorizedValue);
    console.log('Public wallet:', process.env.SELLER_WALLET_ADDRESS);
    console.log('Asset (USDC):', X402_CONFIG.usdcBase);

    // Verify payment with facilitator (do NOT settle yet - settle after content delivery per x402 spec)
    const verification = await verifyPayment(paymentPayload.payload, paymentRequirements);
    if (!verification.isValid) {
      return c.json({ 
        error: 'Payment verification failed', 
        reason: verification.invalidReason 
      }, 402);
    }
    
    // Store the inner payment payload (signature + authorization) for post-delivery settlement
    c.set('paymentPayload', paymentPayload.payload);
    c.set('paymentRequirements', paymentRequirements);
    c.set('nonce', nonce);
    
    await next();
  } catch (error) {
    console.error('Payment middleware error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Protected generate endpoint - payment required
// x402 spec: verify → deliver content → settle (fair billing - only charge on success)
app.post('/generate', async (c) => {
  try {
    const body = await c.req.json();
    
    // Step 1: Generate content (payment already verified in middleware)
    const bedrockResponse = await callBedrockLambda(body.content, body.model);
    
    // Step 2: Content delivered successfully - now settle payment
    const paymentPayload = c.get('paymentPayload');
    const paymentRequirements = c.get('paymentRequirements');
    const nonce = c.get('nonce');
    
    const settlement = await settlePayment(paymentPayload, paymentRequirements);
    if (!settlement.success) {
      // Content was generated but settlement failed - log and return content anyway
      // The verify already confirmed the signature is valid, settlement is on-chain execution
      console.warn('Settlement failed after content delivery:', settlement.errorReason);
    }
    
    // Mark transaction as processed using nonce
    if (nonce) {
      processedPayments.set(nonce, Date.now());
      const oneHourAgo = Date.now() - 3600000;
      for (const [n, timestamp] of processedPayments.entries()) {
        if (timestamp < oneHourAgo) processedPayments.delete(n);
      }
    }
    
    const response = { 
      message: "Payment verified - content generated successfully",
      status: "success",
      content: bedrockResponse.content || 'No content generated',
      model: body.model,
      usage: bedrockResponse.usage || {}
    };
    
    if (settlement?.transaction) {
      response.transactionUrl = `https://sepolia.basescan.org/tx/${settlement.transaction}`;
      // x402 spec: PAYMENT-RESPONSE header with Base64-encoded settlement
      c.header('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settlement)).toString('base64'));
    }
    
    return c.json(response);
  } catch (error) {
    // Content generation failed - do NOT settle payment (fair billing)
    console.error('Generate error (payment not settled):', error);
    return c.json({ 
      message: "Payment verified but content generation failed - payment not charged",
      status: "error",
      error: error.message
    }, 500);
  }
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

exports.handler = handle(app);
