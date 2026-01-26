const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require('@aws-sdk/client-bedrock-agentcore');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const agentClient = new BedrockAgentCoreClient({ region: 'us-east-1' });
const s3Client = new S3Client({ region: 'us-east-1' });

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const domain = event.requestContext.domainName;
  const stage = event.requestContext.stage;
  
  const apiGateway = new ApiGatewayManagementApiClient({
    endpoint: `https://${domain}/${stage}`
  });

  const uploadImageToS3 = async (sessionId, imageId, base64Data) => {
    try {
      const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!matches) return base64Data;
      
      const [, imageType, base64] = matches;
      const buffer = Buffer.from(base64, 'base64');
      const key = `${sessionId}/${imageId}.${imageType}`;
      
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.IMAGES_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: `image/${imageType}`
      }));
      
      return await getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: process.env.IMAGES_BUCKET,
        Key: key
      }), { expiresIn: 3600 });
    } catch (error) {
      console.error('S3 upload error:', error);
      return base64Data;
    }
  };

  const sendMessage = async (data) => {
    try {
      await apiGateway.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(data)
      }));
    } catch (error) {
      console.error('Send error:', error);
    }
  };

  try {
    const body = JSON.parse(event.body);
    const { input, session_id } = body;

    if (!input?.prompt) {
      await sendMessage({ type: 'error', message: 'Prompt is required' });
      return { statusCode: 400 };
    }

    const runtimeSessionId = session_id || 'default';
    const payload = JSON.stringify(body);

    await sendMessage({ type: 'processing', message: 'Processing your request...' });

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: process.env.AGENT_RUNTIME_ARN,
      qualifier: 'DEFAULT',
      runtimeSessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(payload)
    });

    const response = await agentClient.send(command);
    const chunks = [];
    let chunkCount = 0;
    
    for await (const chunk of response.response) {
      chunks.push(chunk);
      chunkCount++;
      
      if (chunkCount % 5 === 0) {
        await sendMessage({ type: 'progress', message: 'Still processing...' });
      }
    }
    
    const responseBody = Buffer.concat(chunks).toString('utf-8');
    const parsedResponse = JSON.parse(responseBody);

    const output = parsedResponse.output || {};
    
    // Ensure images object exists
    if (!output.images) {
      output.images = {};
    }
    
    // Process images: upload to S3 and replace with presigned URLs
    if (Object.keys(output.images).length > 0) {
      console.log('Processing images for S3 upload...');
      const processedImages = {};
      
      for (const [id, data] of Object.entries(output.images)) {
        if (typeof data === 'string' && data.startsWith('data:image/')) {
          console.log(`Uploading image ${id} to S3...`);
          processedImages[id] = await uploadImageToS3(runtimeSessionId, id, data);
          console.log(`Image ${id} uploaded`);
        } else {
          processedImages[id] = data;
        }
      }
      
      output.images = processedImages;
    }

    await sendMessage({
      type: 'complete',
      sessionId: runtimeSessionId,
      response: { output }
    });

    return { statusCode: 200 };
  } catch (error) {
    console.error('Agent error:', error);
    await sendMessage({ type: 'error', message: error.message });
    return { statusCode: 500 };
  }
};
