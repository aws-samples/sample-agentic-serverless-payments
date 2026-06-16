// Payment is now gated by AWS WAF native x402 monetization at the CloudFront edge.
// This gateway Lambda only produces content — no in-app verify/settle.

import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';

const app = new Hono();

// CORS middleware
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (c.req.method === 'OPTIONS') {
    return c.text('', 200);
  }

  await next();
});

// Image generation. Payment is enforced upstream by WAF native x402 monetization;
// by the time the request reaches this Lambda it is already paid for.
app.post('/generate_image', async (c) => {
  try {
    const body = await c.req.json();

    return c.json({
      status: 'success',
      request_id: body.request_id,
      message: 'Content generated successfully'
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
