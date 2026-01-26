const { Hono } = require('hono');
const { handle } = require('hono/aws-lambda');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
//const { generateJwt } = require('@coinbase/cdp-sdk/auth');
const https = require('https');

// Initialize outside handler for connection reuse
const app = new Hono();
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

// x402 Configuration
const X402_CONFIG = {
  facilitatorUrl: 'https://x402.org/facilitator',
  usdcBase: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  network: 'base-sepolia',
  scheme: 'exact'
};

// Idempotency cache - track transaction hashes
const processedPayments = new Map();

// Add CORS middleware
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PAYMENT, PAYMENT-SIGNATURE');
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

// Verify payment with x402.org facilitator
const verifyPayment = async (paymentPayload, paymentRequirements) => {
  const requestBody = {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: X402_CONFIG.scheme,
      network: X402_CONFIG.network,
      payload: paymentPayload
    },
    paymentRequirements
  };
  
  console.log('=== VERIFY REQUEST ===');
  console.log('URL: https://x402.org/facilitator/verify');
  
  const bodyString = JSON.stringify(requestBody);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'x402.org',
      port: 443,
      path: '/facilitator/verify',
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

// Settle payment with x402.org facilitator
const settlePayment = async (paymentPayload, paymentRequirements) => {
  const requestBody = {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: X402_CONFIG.scheme,
      network: X402_CONFIG.network,
      payload: paymentPayload
    },
    paymentRequirements
  };
  
  console.log('=== SETTLE REQUEST ===');
  console.log('URL: https://x402.org/facilitator/settle');
  
  const bodyString = JSON.stringify(requestBody);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'x402.org',
      port: 443,
      path: '/facilitator/settle',
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
    
    // Check for PAYMENT-SIGNATURE header (x402 v2) or X-PAYMENT (v1 fallback)
    const paymentSignature = c.req.header('PAYMENT-SIGNATURE');
    const legacyPayment = c.req.header('X-PAYMENT');
    const paymentHeader = paymentSignature || legacyPayment;
    
    if (!paymentHeader) {
      const publicWallet = process.env.SELLER_WALLET_ADDRESS;
      const paymentRequirements = {
        scheme: X402_CONFIG.scheme,
        network: X402_CONFIG.network,
        maxAmountRequired: String(estimatedCost),
        resource: `${process.env.API_GATEWAY_HTTP_URL}/generate`,
        description: `AI content generation with ${model}`,
        mimeType: 'application/json',
        outputSchema: { content: 'string', model: 'string' },
        payTo: publicWallet,
        asset: X402_CONFIG.usdcBase,
        maxTimeoutSeconds: 300
      };
      console.log('=== 402 RESPONSE PAYMENT REQUIREMENTS ===');
      console.log(JSON.stringify(paymentRequirements, null, 2));
      // x402 spec: PAYMENT-REQUIRED header with Base64-encoded requirements
      c.header('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequirements)).toString('base64'));
      return c.json(paymentRequirements, 402);
    }
    
    // Parse payment payload (Base64 for PAYMENT-SIGNATURE, JSON for X-PAYMENT)
    let paymentPayload;
    try {
      if (paymentSignature) {
        paymentPayload = JSON.parse(Buffer.from(paymentSignature, 'base64').toString('utf-8'));
      } else {
        paymentPayload = JSON.parse(paymentHeader);
      }
    } catch (error) {
      return c.json({ error: 'Invalid payment payload' }, 400);
    }
    
    // Extract value from authorization to ensure consistency
    const authorizedValue = paymentPayload.authorization?.value;
    if (!authorizedValue) {
      return c.json({ error: 'Missing authorization value' }, 400);
    }
    
    // Idempotency check using nonce
    const nonce = paymentPayload.authorization?.nonce;
    if (nonce && processedPayments.has(nonce)) {
      return c.json({ error: 'Payment already processed' }, 409);
    }
    
    // Create payment requirements using the EXACT value from authorization
    const publicWallet = process.env.SELLER_WALLET_ADDRESS;
    const paymentRequirements = {
      scheme: X402_CONFIG.scheme,
      network: X402_CONFIG.network,
      maxAmountRequired: authorizedValue,
      resource: `${process.env.API_GATEWAY_HTTP_URL}/generate`,
      description: `AI content generation with ${model}`,
      mimeType: 'application/json',
      outputSchema: { content: 'string', model: 'string' },
      payTo: publicWallet,
      asset: X402_CONFIG.usdcBase,
      maxTimeoutSeconds: 300,
      extra: {
        name: 'USDC',
        version: '2',
        chainId: 84532
      }
    };
    
    console.log('=== PAYMENT VERIFICATION ===');
    console.log('Payment requirements:', JSON.stringify(paymentRequirements, null, 2));
    console.log('Payment payload from client:', JSON.stringify(paymentPayload, null, 2));
    console.log('Authorization value:', authorizedValue);
    console.log('Public wallet:', publicWallet);
    console.log('Asset (USDC):', X402_CONFIG.usdcBase);
    
    // Verify payment with Coinbase facilitator
    const verification = await verifyPayment(paymentPayload, paymentRequirements);
    if (!verification.isValid) {
      return c.json({ 
        error: 'Payment verification failed', 
        reason: verification.invalidReason 
      }, 402);
    }
    
    // Settle payment with Coinbase facilitator
    const settlement = await settlePayment(paymentPayload, paymentRequirements);
    if (!settlement.success) {
      return c.json({ 
        error: 'Payment settlement failed', 
        reason: settlement.errorReason 
      }, 402);
    }
    
    // Mark transaction as processed using nonce
    if (nonce) {
      processedPayments.set(nonce, Date.now());
      // Clean old entries (older than 1 hour)
      const oneHourAgo = Date.now() - 3600000;
      for (const [n, timestamp] of processedPayments.entries()) {
        if (timestamp < oneHourAgo) processedPayments.delete(n);
      }
    }
    
    // Store settlement info for response
    c.set('settlement', settlement);
    
    await next();
  } catch (error) {
    console.error('Payment middleware error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Protected generate endpoint - payment required
app.post('/generate', async (c) => {
  try {
    const body = await c.req.json();
    const bedrockResponse = await callBedrockLambda(body.content, body.model);
    const settlement = c.get('settlement');
    
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
    console.error('Generate error:', error);
    return c.json({ 
      message: "Payment verified but content generation failed",
      status: "error",
      error: error.message
    }, 500);
  }
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

exports.handler = handle(app);
