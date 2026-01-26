const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const ttl = Math.floor(Date.now() / 1000) + 7200;

  try {
    await docClient.send(new PutCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Item: { connectionId, timestamp: Date.now(), ttl }
    }));

    return { statusCode: 200, body: 'Connected' };
  } catch (error) {
    console.error('Connect error:', error);
    return { statusCode: 500, body: 'Failed to connect' };
  }
};
