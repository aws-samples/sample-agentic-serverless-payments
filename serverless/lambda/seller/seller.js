// Payment is now gated by AWS WAF native x402 monetization at the CloudFront edge.
// This seller Lambda only produces content (Bedrock Nova) — no in-app verify/settle.

const { Hono } = require('hono');
const { handle } = require('hono/aws-lambda');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// Initialize outside handler for connection reuse
const app = new Hono();
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

// Add CORS middleware
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (c.req.method === 'OPTIONS') {
    return c.text('', 200);
  }

  await next();
});

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

// Content generation. Payment is enforced upstream by WAF native x402 monetization;
// by the time the request reaches this Lambda it is already paid for. The path
// (/generate-text vs /generate-image) drives WAF pricing; the seller still reads
// `model` from the body to pick the Bedrock Nova model.
const generate = async (c) => {
  try {
    const body = await c.req.json();
    const { content = '', model = 'nova-llm' } = body;

    const bedrockResponse = await callBedrockLambda(content, model);

    return c.json({
      message: 'Content generated successfully',
      status: 'success',
      content: bedrockResponse.content || 'No content generated',
      model,
      usage: bedrockResponse.usage || {}
    });
  } catch (error) {
    console.error('Generate error:', error);
    return c.json({
      message: 'Content generation failed',
      status: 'error',
      error: error.message
    }, 500);
  }
};

app.post('/generate-text', generate);
app.post('/generate-image', generate);

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

exports.handler = handle(app);
