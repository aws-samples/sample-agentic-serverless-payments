const { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const bedrock = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION });

const modelIds = {
  'nova-llm': 'us.amazon.nova-2-lite-v1:0',
  'nova-canvas': 'amazon.nova-canvas-v1:0'
};

exports.handler = async (event) => {

  try {
    console.log('Event received:', JSON.stringify(event));
    const body = JSON.parse(event.body || '{}');
    console.log('Parsed body:', JSON.stringify(body));
    const { model = 'nova-llm', content = '' } = body;
    
    const modelId = modelIds[model] || modelIds['nova-llm'];
    console.log('Using model ID:', modelId);
    
    let responseContent;
    
    if (model === 'nova-llm') {
      const command = new ConverseCommand({
        modelId,
        messages: [{ 
          role: "user", 
          content: [{ text: content }]
        }]
      });
      
      console.log('Invoking Bedrock Converse...');
      const response = await bedrock.send(command);
      console.log('Bedrock response received');
      
      responseContent = response.output?.message?.content?.[0]?.text || 'No response';
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          content: responseContent,
          usage: response.usage || {}
        })
      };
    } else if (model === 'nova-canvas') {
      const requestBody = {
        taskType: "TEXT_IMAGE",
        textToImageParams: { text: content },
        imageGenerationConfig: {
          numberOfImages: 1,
          height: 1024,
          width: 1024
        }
      };
      
      const command = new InvokeModelCommand({
        modelId,
        body: JSON.stringify(requestBody)
      });
      
      console.log('Invoking Bedrock InvokeModel...');
      const response = await bedrock.send(command);
      console.log('Bedrock response received');
      
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      
      if (responseBody.images && responseBody.images[0]) {
        responseContent = `data:image/png;base64,${responseBody.images[0]}`;
      } else {
        responseContent = 'Image generation failed';
      }
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          content: responseContent,
          usage: {}
        })
      };
    }
    
  } catch (error) {
    console.error('Error in Bedrock Lambda:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(error), stack: error.stack })
    };
  }
};