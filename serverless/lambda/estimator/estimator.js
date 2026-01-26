const { BedrockRuntimeClient, CountTokensCommand } = require('@aws-sdk/client-bedrock-runtime');
const https = require('https');

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

// Bedrock Nova pricing (USD)
const PRICING = {
  'nova-llm': { input: 0.0003, output: 0.0025 }, // per 1K tokens
  'nova-canvas': { perImage: 0.04 } // per image, no output cost
};

const countTokens = async (model, content) => {
  try {
    const modelId = model === 'nova-canvas' ? 'amazon.nova-canvas-v1:0' : 'us.amazon.nova-2-lite-v1:0';
    const command = new CountTokensCommand({ modelId, inputText: content });
    const response = await bedrock.send(command);
    return response.inputTokenCount || Math.ceil(content.length / 4);
  } catch (error) {
    return Math.ceil(content.length / 4);
  }
};

const getUsdcPrice = () => {
  return new Promise((resolve) => {
    https.get('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const price = parsed['usd-coin']?.usd;
          resolve(price || 1.0); // USDC should be ~$1
        } catch (error) {
          resolve(1.0); // Fallback to $1
        }
      });
    }).on('error', () => resolve(1.0));
  });
};

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { model = 'nova-llm', content = '' } = body;
    
    const [inputTokens, usdcPrice] = await Promise.all([
      countTokens(model, content),
      getUsdcPrice()
    ]);
    
    const pricing = PRICING[model] || PRICING['nova-llm'];
    
    let totalCostUSD, estimatedOutputTokens;
    
    if (model === 'nova-canvas') {
      totalCostUSD = pricing.perImage;
      estimatedOutputTokens = 0;
    } else {
      estimatedOutputTokens = Math.min(Math.max(Math.ceil(inputTokens * 0.5 * 1.2), 800), 4096);
      const inputCost = (inputTokens / 1000) * pricing.input;
      const outputCost = (estimatedOutputTokens / 1000) * pricing.output;
      totalCostUSD = inputCost + outputCost;
    }
    const totalCostUSDC = (totalCostUSD / usdcPrice) * 1e6; // Convert to USDC wei
    
    const finalCost = Math.max(Math.ceil(totalCostUSDC), 1); // Minimum 1 wei
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        inputTokens,
        estimatedOutputTokens,
        totalCost: finalCost.toString(),
        usdcPrice
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(error) })
    };
  }
};