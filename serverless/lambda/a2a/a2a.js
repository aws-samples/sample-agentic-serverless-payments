import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import https from 'https';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const app = new Hono();
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const X402_CONFIG = {
  usdcBase: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  network: 'base-sepolia',
  scheme: 'exact',
};

const IMAGE_COST_WEI = String(0.04 * 1_000_000 | 0); // $0.04 USDC in 6-decimal wei

const NETWORK_TO_EIP155 = {
  'base-sepolia': 'eip155:84532',
  'base': 'eip155:8453',
  'mainnet': 'eip155:1',
};

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, X-A2A-Extensions');
  if (c.req.method === 'OPTIONS') return c.text('', 200);
  await next();
});

function buildTask(taskId, state, parts, metadata) {
  const task = {
    kind: 'task',
    id: taskId,
    status: {
      state,
      message: { kind: 'message', role: 'agent', parts },
    },
  };
  if (metadata) task.status.message.metadata = metadata;
  return task;
}

async function facilitatorPost(path, body) {
  const bodyString = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const makeRequest = (url) => {
      const parsedUrl = new URL(url);
      const req = https.request({
        hostname: parsedUrl.hostname, port: parsedUrl.port || 443, path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyString) },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return makeRequest(res.headers.location);
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Parse error: ${data}`)); } });
      });
      req.on('error', reject);
      req.write(bodyString);
      req.end();
    };
    makeRequest(`https://x402.org/facilitator/${path}`);
  });
}

async function invokeBedrockLambda(prompt) {
  const payload = JSON.stringify({ action: 'generate_image', prompt });
  const response = await lambda.send(new InvokeCommand({
    FunctionName: process.env.BEDROCK_LAMBDA_ARN,
    Payload: Buffer.from(payload),
  }));
  const result = JSON.parse(Buffer.from(response.Payload).toString());
  if (result.errorMessage) throw new Error(result.errorMessage);
  return result.image_b64 || result.imageBase64 || result.image;
}

app.post('/a2a', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

  const { jsonrpc, id, method, params } = body;
  if (method !== 'message/send') {
    return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  const message = params?.message || {};
  const taskId = message.taskId || crypto.randomUUID();
  const metadata = message.metadata || {};
  const parts = message.parts || [];
  const prompt = parts.find(p => p.kind === 'text')?.text || 'A beautiful AI-generated image';

  const gatewayUrl = (process.env.GATEWAY_URL || 'https://example.com').replace(/\/$/, '');
  const sellerWallet = process.env.SELLER_WALLET || '';
  const rawNetwork = process.env.NETWORK_ID || 'base-sepolia';
  const eip155Network = NETWORK_TO_EIP155[rawNetwork] || 'eip155:84532';
  const usdcContract = process.env.USDC_CONTRACT || X402_CONFIG.usdcBase;

  const paymentRequirements = {
    scheme: 'exact',
    network: eip155Network,
    amount: IMAGE_COST_WEI,
    asset: usdcContract,
    payTo: sellerWallet,
    maxTimeoutSeconds: 600,
    extra: { name: 'USDC', version: '2', decimals: 6 },
  };

  // Leg 1 — no payment yet
  if (metadata['x402.payment.status'] !== 'payment-submitted') {
    const task = buildTask(taskId, 'input-required',
      [{ kind: 'text', text: 'Payment required to generate image.' }],
      {
        'x402.payment.status': 'payment-required',
        'x402.payment.required': {
          x402Version: 2, error: 'Payment required',
          resource: { url: `${gatewayUrl}/a2a`, description: 'AI image generation via Amazon Nova Canvas', mimeType: 'application/json' },
          accepts: [paymentRequirements],
        },
      });
    return c.json({ jsonrpc: '2.0', id, result: task });
  }

  // Leg 2 — payment submitted
  const paymentPayloadRaw = metadata['x402.payment.payload'] || {};
  const actualPayload = paymentPayloadRaw.payload || paymentPayloadRaw;

  const x402Body = {
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: 'exact', network: 'base-sepolia', payload: actualPayload },
    paymentRequirements,
  };

  let verification;
  try { verification = await facilitatorPost('verify', x402Body); }
  catch (err) {
    return c.json({ jsonrpc: '2.0', id, result: buildTask(taskId, 'failed',
      [{ kind: 'text', text: `Payment verification error: ${err.message}` }],
      { 'x402.payment.status': 'payment-failed', 'x402.payment.error': err.message }) });
  }

  if (!verification.isValid) {
    return c.json({ jsonrpc: '2.0', id, result: buildTask(taskId, 'failed',
      [{ kind: 'text', text: `Invalid payment: ${verification.invalidReason}` }],
      { 'x402.payment.status': 'payment-failed', 'x402.payment.error': verification.invalidReason }) });
  }

  // Generate image (settle only on success — fair billing)
  let imageB64;
  try { imageB64 = await invokeBedrockLambda(prompt); }
  catch (err) {
    return c.json({ jsonrpc: '2.0', id, result: buildTask(taskId, 'failed',
      [{ kind: 'text', text: 'Image generation failed — payment not charged.' }],
      { 'x402.payment.status': 'payment-accepted', 'x402.payment.error': `generation_failed: ${err.message}`, 'x402.payment.receipts': [] }) });
  }

  const receipts = [];
  try {
    const settlement = await facilitatorPost('settle', x402Body);
    receipts.push({ success: !!settlement.success, transaction: settlement.transaction, network: eip155Network });
  } catch (err) {
    receipts.push({ success: false, errorReason: err.message, network: eip155Network });
  }

  const artifactId = crypto.randomUUID();
  const task = buildTask(taskId, 'completed',
    [{ kind: 'text', text: `Image generated: ${prompt.slice(0, 80)}` }],
    {
      'x402.payment.status': 'payment-settled',
      'x402.payment.receipts': receipts,
      'x402.payment.lifecycle': ['payment-required', 'payment-submitted', 'payment-accepted', 'payment-settled'],
    });
  task.artifacts = [{
    artifactId,
    name: 'generated-image.png',
    description: `Nova Canvas image: ${prompt.slice(0, 80)}`,
    mimeType: 'image/png',
    data: imageB64,
  }];
  return c.json({ jsonrpc: '2.0', id, result: task });
});

app.get('/health', (c) => c.json({ status: 'healthy' }));

export const handler = handle(app);
