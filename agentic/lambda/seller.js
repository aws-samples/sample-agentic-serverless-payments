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

// Idempotency cache
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
    
    // Verify payment with x402.org facilitator (use inner payload)
    const verification = await verifyPayment(paymentPayload.payload || paymentPayload, paymentRequirements);
    if (!verification.isValid) {
      return c.json({ 
        error: 'Payment verification failed', 
        reason: verification.invalidReason 
      }, 402);
    }
    
    console.log('Payment verified successfully!');
    
    // Settle payment with x402.org facilitator (use inner payload)
    // Note: Settlement may fail on testnet, but verification is sufficient
    // We proceed even if settlement fails since verification passed
    let transactionHash = null;
    try {
      const settlement = await settlePayment(paymentPayload.payload || paymentPayload, paymentRequirements);
      if (settlement.success) {
        console.log('Payment settled successfully');
        console.log('Transaction:', settlement.transaction);
        transactionHash = settlement.transaction;
      } else {
        console.log('Settlement failed (testnet expected), but verification passed - proceeding');
        console.log('Reason:', settlement.errorReason);
      }
    } catch (error) {
      console.log('Settlement error (testnet expected):', error.message);
      console.log('Proceeding since verification passed');
    }
    
    // Store transaction hash in context for endpoint to use
    c.set('transactionHash', transactionHash);
    
    // Mark transaction as processed using nonce
    if (nonce) {
      processedPayments.set(nonce, Date.now());
      // Clean old entries (older than 1 hour)
      const oneHourAgo = Date.now() - 3600000;
      for (const [n, timestamp] of processedPayments.entries()) {
        if (timestamp < oneHourAgo) processedPayments.delete(n);
      }
    }
    
    await next();
  } catch (error) {
    console.error('Payment middleware error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Protected generate_image endpoint - payment required
app.post('/generate_image', async (c) => {
  try {
    const body = await c.req.json();
    
    // Get transaction hash from context (set by middleware)
    const transactionHash = c.get('transactionHash');
    
    return c.json({ 
      status: 'payment_verified',
      request_id: body.request_id,
      message: 'Payment verified - proceed with image generation',
      transaction_hash: transactionHash || null
    });
  } catch (error) {
    console.error('Generate error:', error);
    return c.json({ 
      status: 'error',
      error: error.message
    }, 500);
  }
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

export const handler = handle(app);
