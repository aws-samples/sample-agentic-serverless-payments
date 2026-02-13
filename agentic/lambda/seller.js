import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import https from 'https';

const app = new Hono();

// x402 Configuration
const X402_CONFIG = {
  facilitatorUrl: 'https://x402.org/facilitator',
  usdcBase: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  network: 'base-sepolia',
  scheme: 'exact'
};

// Idempotency cache - for production, persist to DynamoDB for multi-instance scalability
const processedPayments = new Map();

// CORS middleware
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
const { generateJwt } = require('@coinbase/cdp-sdk/auth');

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
  const bodyString = JSON.stringify(requestBody);
  
  return new Promise((resolve, reject) => {
    const makeRequest = (url) => {
      const parsedUrl = new URL(url);
      const req = https.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyString)
        }
      }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log(`Redirecting to: ${res.headers.location}`);
          return makeRequest(res.headers.location);
        }
        
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          console.log('Verify response status:', res.statusCode);
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
    };
    
    makeRequest('https://x402.org/facilitator/verify');
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
  const bodyString = JSON.stringify(requestBody);
  
  return new Promise((resolve, reject) => {
    const makeRequest = (url) => {
      const parsedUrl = new URL(url);
      const req = https.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyString)
        }
      }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log(`Redirecting to: ${res.headers.location}`);
          return makeRequest(res.headers.location);
        }
        
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          console.log('Settle response status:', res.statusCode);
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
    };
    
    makeRequest('https://x402.org/facilitator/settle');
  });
};

// x402 compliant payment middleware for /generate_image route
app.use('/generate_image', async (c, next) => {
  try {
    const body = await c.req.json();
    const { request_id, prompt, price } = body;
    
    // Use provided price or default estimate (in USDC wei)
    const estimatedCost = price || '20000'; // ~$0.02 default
    
    // Check for PAYMENT-SIGNATURE header (x402 v2 standard) or X-PAYMENT (legacy)
    const paymentHeader = c.req.header('PAYMENT-SIGNATURE') || c.req.header('X-PAYMENT');
    
    if (!paymentHeader) {
      const sellerWallet = process.env.SELLER_WALLET;
      const paymentRequirements = {
        scheme: X402_CONFIG.scheme,
        network: X402_CONFIG.network,
        maxAmountRequired: String(estimatedCost),
        resource: `${(process.env.GATEWAY_URL || 'https://example.com').replace(/\/$/, '')}/generate_image`,
        description: 'AI image generation with Nova Canvas',
        mimeType: 'application/json',
        outputSchema: { status: 'string', request_id: 'string', message: 'string' },
        payTo: sellerWallet,
        asset: X402_CONFIG.usdcBase,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USDC',
          version: '2',
          chainId: 84532
        }
      };
      const x402Response = {
        x402Version: 1,
        accepts: [paymentRequirements],
        error: 'Payment required'
      };
      console.log('=== 402 RESPONSE ===');
      console.log(JSON.stringify(x402Response, null, 2));
      return c.json(x402Response, 402);
    }
    
    // Parse payment payload (base64 encoded)
    let paymentPayload;
    try {
      const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      paymentPayload = JSON.parse(decoded);
      console.log('=== PAYMENT RECEIVED ===');
      console.log('Payload:', JSON.stringify(paymentPayload, null, 2));
    } catch (error) {
      console.log('Parse error:', error.message);
      return c.json({ error: 'Invalid payment payload' }, 400);
    }
    
    // Extract authorization (handle both formats)
    const authorization = paymentPayload.payload?.authorization || paymentPayload.authorization;
    const authorizedValue = authorization?.value;
    if (!authorizedValue) {
      console.log('Missing authorization value');
      return c.json({ error: 'Missing authorization value' }, 400);
    }
    
    // Idempotency check using nonce
    const nonce = authorization?.nonce;
    if (nonce && processedPayments.has(nonce)) {
      return c.json({ error: 'Payment already processed' }, 409);
    }
    
    // Create payment requirements using EXACT value from authorization
    const sellerWallet = process.env.SELLER_WALLET;
    const paymentRequirements = {
      scheme: X402_CONFIG.scheme,
      network: X402_CONFIG.network,
      maxAmountRequired: authorizedValue,
      resource: `${(process.env.GATEWAY_URL || 'https://example.com').replace(/\/$/, '')}/generate_image`,
      description: 'AI image generation with Nova Canvas',
      mimeType: 'application/json',
      outputSchema: { status: 'string', request_id: 'string', message: 'string' },
      payTo: sellerWallet,
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
    console.log('Seller wallet:', sellerWallet);
    console.log('Asset (USDC):', X402_CONFIG.usdcBase);
    
    // Verify payment with x402.org facilitator (do NOT settle yet - settle after content delivery per x402 spec)
    const verification = await verifyPayment(paymentPayload.payload || paymentPayload, paymentRequirements);
    if (!verification.isValid) {
      return c.json({ 
        error: 'Payment verification failed', 
        reason: verification.invalidReason 
      }, 402);
    }
    
    console.log('Payment verified successfully!');
    
    // Store payment data for deferred settlement via /settle endpoint
    c.set('paymentPayload', paymentPayload);
    c.set('paymentRequirements', paymentRequirements);
    c.set('nonce', nonce);
    
    // Mark nonce as pending (prevents replay while awaiting settlement)
    if (nonce) {
      processedPayments.set(nonce, { timestamp: Date.now(), status: 'pending', paymentPayload: paymentPayload.payload || paymentPayload, paymentRequirements });
      
      // Clean up stale pending entries (never settled, e.g. Bedrock failure) and old settled entries
      const oneHourAgo = Date.now() - 3600000;
      for (const [n, entry] of processedPayments.entries()) {
        const ts = typeof entry === 'object' ? entry.timestamp : entry;
        if (ts < oneHourAgo) processedPayments.delete(n);
      }
    }
    
    await next();
  } catch (error) {
    console.error('Payment middleware error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Protected generate_image endpoint - payment verified, content can proceed
app.post('/generate_image', async (c) => {
  try {
    const body = await c.req.json();
    const nonce = c.get('nonce');
    
    return c.json({ 
      status: 'payment_verified',
      request_id: body.request_id,
      message: 'Payment verified - proceed with image generation',
      nonce: nonce || null
    });
  } catch (error) {
    console.error('Generate error:', error);
    return c.json({ 
      status: 'error',
      error: error.message
    }, 500);
  }
});

// x402 spec: settle after content delivery (fair billing - only charge on success)
app.post('/settle', async (c) => {
  try {
    const body = await c.req.json();
    const { nonce } = body;
    
    if (!nonce) {
      return c.json({ error: 'Missing nonce' }, 400);
    }
    
    // Look up pending payment data by nonce
    const pendingPayment = processedPayments.get(nonce);
    if (!pendingPayment || pendingPayment.status !== 'pending') {
      return c.json({ error: 'No pending payment found for nonce' }, 404);
    }
    
    const { paymentPayload, paymentRequirements } = pendingPayment;
    
    let transactionHash = null;
    try {
      const settlement = await settlePayment(paymentPayload, paymentRequirements);
      if (settlement.success) {
        console.log('Payment settled successfully');
        console.log('Transaction:', settlement.transaction);
        transactionHash = settlement.transaction;
      } else {
        console.log('Settlement failed (testnet expected):', settlement.errorReason);
      }
    } catch (error) {
      console.log('Settlement error (testnet expected):', error.message);
    }
    
    // Mark as settled and clean old entries
    processedPayments.set(nonce, { timestamp: Date.now(), status: 'settled' });
    const oneHourAgo = Date.now() - 3600000;
    for (const [n, entry] of processedPayments.entries()) {
      const ts = typeof entry === 'object' ? entry.timestamp : entry;
      if (ts < oneHourAgo) processedPayments.delete(n);
    }
    
    return c.json({
      status: 'settled',
      transaction_hash: transactionHash
    });
  } catch (error) {
    console.error('Settlement error:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

export const handler = handle(app);
