import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import https from 'https';
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const app = new Hono();

const X402_CONFIG = {
  facilitatorUrl: 'https://x402.org/facilitator',
  usdcBase: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  network: 'base-sepolia',
  scheme: 'exact'
};

// DynamoDB-backed nonce store — shared across all Lambda instances so replay
// protection holds even when the function scales horizontally.
// Falls back to an in-process Map when the env var is absent (local dev / tests).
const dynamodb = process.env.NONCE_TABLE_NAME
  ? new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })
  : null;

const localNonceCache = new Map();

const MAX_PAYMENT_AGE_SEC = 300;

async function markNoncePending(nonce, paymentPayload, paymentRequirements) {
  const ttl = Math.floor(Date.now() / 1000) + 3600;
  if (dynamodb) {
    await dynamodb.send(new PutItemCommand({
      TableName: process.env.NONCE_TABLE_NAME,
      Item: {
        nonce: { S: nonce },
        status: { S: 'pending' },
        paymentPayload: { S: JSON.stringify(paymentPayload) },
        paymentRequirements: { S: JSON.stringify(paymentRequirements) },
        createdAt: { N: String(Math.floor(Date.now() / 1000)) },
        ttl: { N: String(ttl) },
      },
      ConditionExpression: 'attribute_not_exists(nonce)',
    }));
  } else {
    if (localNonceCache.has(nonce)) throw new Error('Duplicate nonce');
    localNonceCache.set(nonce, { status: 'pending', paymentPayload, paymentRequirements, ts: Date.now() });
  }
}

async function getNonceEntry(nonce) {
  if (dynamodb) {
    const res = await dynamodb.send(new GetItemCommand({
      TableName: process.env.NONCE_TABLE_NAME,
      Key: { nonce: { S: nonce } },
    }));
    if (!res.Item) return null;
    return {
      status: res.Item.status.S,
      paymentPayload: JSON.parse(res.Item.paymentPayload.S),
      paymentRequirements: JSON.parse(res.Item.paymentRequirements.S),
    };
  } else {
    return localNonceCache.get(nonce) || null;
  }
}

async function markNonceSettled(nonce) {
  if (dynamodb) {
    await dynamodb.send(new UpdateItemCommand({
      TableName: process.env.NONCE_TABLE_NAME,
      Key: { nonce: { S: nonce } },
      UpdateExpression: 'SET #s = :settled',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':settled': { S: 'settled' } },
    }));
  } else {
    const entry = localNonceCache.get(nonce);
    if (entry) entry.status = 'settled';
  }
}

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PAYMENT, PAYMENT-SIGNATURE');
  c.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  if (c.req.method === 'OPTIONS') return c.text('', 200);
  await next();
});

const verifyPayment = async (paymentPayload, paymentRequirements) => {
  const requestBody = {
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: X402_CONFIG.scheme, network: X402_CONFIG.network, payload: paymentPayload },
    paymentRequirements
  };
  const bodyString = JSON.stringify(requestBody);
  return new Promise((resolve, reject) => {
    const makeRequest = (url) => {
      const parsedUrl = new URL(url);
      const req = https.request({
        hostname: parsedUrl.hostname, port: parsedUrl.port || 443, path: parsedUrl.pathname,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyString) }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return makeRequest(res.headers.location);
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Failed to parse: ${data}`)); } });
      });
      req.on('error', (e) => reject(e));
      req.write(bodyString);
      req.end();
    };
    makeRequest('https://x402.org/facilitator/verify');
  });
};

const settlePayment = async (paymentPayload, paymentRequirements) => {
  const requestBody = {
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: X402_CONFIG.scheme, network: X402_CONFIG.network, payload: paymentPayload },
    paymentRequirements
  };
  const bodyString = JSON.stringify(requestBody);
  return new Promise((resolve, reject) => {
    const makeRequest = (url) => {
      const parsedUrl = new URL(url);
      const req = https.request({
        hostname: parsedUrl.hostname, port: parsedUrl.port || 443, path: parsedUrl.pathname,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyString) }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return makeRequest(res.headers.location);
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Failed to parse: ${data}`)); } });
      });
      req.on('error', (e) => reject(e));
      req.write(bodyString);
      req.end();
    };
    makeRequest('https://x402.org/facilitator/settle');
  });
};

app.use('/generate_image', async (c, next) => {
  try {
    const body = await c.req.json();
    const { request_id, prompt, price } = body;
    const estimatedCost = price || '20000';
    const paymentHeader = c.req.header('PAYMENT-SIGNATURE') || c.req.header('X-PAYMENT');

    if (!paymentHeader) {
      const sellerWallet = process.env.SELLER_WALLET;
      const paymentRequirements = {
        scheme: X402_CONFIG.scheme, network: X402_CONFIG.network,
        maxAmountRequired: String(estimatedCost),
        resource: `${(process.env.GATEWAY_URL || 'https://example.com').replace(/\/$/, '')}/generate_image`,
        description: 'AI image generation with Nova Canvas', mimeType: 'application/json',
        outputSchema: { status: 'string', request_id: 'string', message: 'string' },
        payTo: sellerWallet, asset: X402_CONFIG.usdcBase, maxTimeoutSeconds: 300,
        extra: { name: 'USDC', version: '2', chainId: 84532 }
      };
      return c.json({ x402Version: 1, accepts: [paymentRequirements], error: 'Payment required' }, 402);
    }

    let paymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    } catch (error) {
      return c.json({ error: 'Invalid payment payload' }, 400);
    }

    const authorization = paymentPayload.payload?.authorization || paymentPayload.authorization;
    const authorizedValue = authorization?.value;
    if (!authorizedValue) return c.json({ error: 'Missing authorization value' }, 400);

    // Reject expired or stale signatures
    const validBefore = Number(authorization?.validBefore || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (validBefore > 0 && nowSec > validBefore) {
      return c.json({ error: 'payment_expired', reason: 'Payment signature has expired' }, 402);
    }
    const validAfter = Number(authorization?.validAfter || 0);
    if ((nowSec - validAfter) > MAX_PAYMENT_AGE_SEC) {
      return c.json({ error: 'payment_expired', reason: `Signature older than ${MAX_PAYMENT_AGE_SEC} seconds` }, 402);
    }

    // Idempotency check — DynamoDB-backed across Lambda instances
    const nonce = authorization?.nonce;
    if (nonce) {
      const existing = await getNonceEntry(nonce);
      if (existing) return c.json({ error: 'Payment already processed' }, 409);
    }

    const sellerWallet = process.env.SELLER_WALLET;
    const paymentRequirements = {
      scheme: X402_CONFIG.scheme, network: X402_CONFIG.network,
      maxAmountRequired: authorizedValue,
      resource: `${(process.env.GATEWAY_URL || 'https://example.com').replace(/\/$/, '')}/generate_image`,
      description: 'AI image generation with Nova Canvas', mimeType: 'application/json',
      outputSchema: { status: 'string', request_id: 'string', message: 'string' },
      payTo: sellerWallet, asset: X402_CONFIG.usdcBase, maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2', chainId: 84532 }
    };

    const verification = await verifyPayment(paymentPayload.payload || paymentPayload, paymentRequirements);
    if (!verification.isValid) {
      return c.json({ error: 'Payment verification failed', reason: verification.invalidReason }, 402);
    }

    // Persist nonce atomically — ConditionalCheckFailedException means concurrent replay
    if (nonce) {
      try {
        await markNoncePending(nonce, paymentPayload.payload || paymentPayload, paymentRequirements);
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return c.json({ error: 'Payment already processed' }, 409);
        throw err;
      }
    }

    c.set('paymentPayload', paymentPayload);
    c.set('paymentRequirements', paymentRequirements);
    c.set('nonce', nonce);
    await next();
  } catch (error) {
    console.error('Payment middleware error:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.post('/generate_image', async (c) => {
  try {
    const body = await c.req.json();
    const nonce = c.get('nonce');
    return c.json({ status: 'payment_verified', request_id: body.request_id, message: 'Payment verified - proceed with image generation', nonce: nonce || null });
  } catch (error) {
    return c.json({ status: 'error', error: error.message }, 500);
  }
});

app.post('/settle', async (c) => {
  try {
    const body = await c.req.json();
    const { nonce } = body;
    if (!nonce) return c.json({ error: 'Missing nonce' }, 400);

    const pendingPayment = await getNonceEntry(nonce);
    if (!pendingPayment || pendingPayment.status !== 'pending') {
      return c.json({ error: 'No pending payment found for nonce' }, 404);
    }

    const { paymentPayload, paymentRequirements } = pendingPayment;
    let transactionHash = null;
    try {
      const settlement = await settlePayment(paymentPayload, paymentRequirements);
      if (settlement.success) transactionHash = settlement.transaction;
    } catch (error) {
      console.log('Settlement error (testnet expected):', error.message);
    }

    await markNonceSettled(nonce);
    return c.json({ status: 'settled', transaction_hash: transactionHash });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/health', (c) => c.json({ status: 'healthy' }));

export const handler = handle(app);
