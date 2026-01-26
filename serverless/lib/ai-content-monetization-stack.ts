import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export class AiContentMonetizationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Estimator Lambda (esbuild bundled)
    const estimatorLambda = new nodejs.NodejsFunction(this, 'EstimatorLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: 'lambda/estimator/estimator.js',
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        BEDROCK_REGION: this.region
      }
    });

    // Bedrock Lambda for Nova models (esbuild bundled)
    const bedrockLambda = new nodejs.NodejsFunction(this, 'BedrockLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: 'lambda/bedrock/bedrock.js',
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      environment: {
        BEDROCK_REGION: this.region
      }
    });

    // Seller Lambda with X402 payment middleware
    const sellerLambda = new nodejs.NodejsFunction(this, 'SellerLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: 'lambda/seller/seller.js',
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      bundling: {
        externalModules: ['aws-sdk']
      },
      environment: {
        SELLER_WALLET_ADDRESS: process.env.SELLER_WALLET_ADDRESS || '',
        BEDROCK_LAMBDA_NAME: bedrockLambda.functionName,
        ESTIMATOR_LAMBDA_NAME: estimatorLambda.functionName,
        API_GATEWAY_HTTP_URL: process.env.API_GATEWAY_HTTP_URL || '',
        CDP_API_KEY_NAME: process.env.CDP_API_KEY_NAME || '',
        CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET || ''
      }
    });

    // Bedrock permissions
    bedrockLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: ['*']
    }));

    // Pricing API permissions for estimator
    estimatorLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['pricing:GetProducts'],
      resources: ['*']
    }));

    // Allow seller Lambda to invoke Bedrock and Estimator Lambdas
    sellerLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [bedrockLambda.functionArn, estimatorLambda.functionArn]
    }));

    // HTTP API Gateway (v2)
    const httpApi = new apigatewayv2.HttpApi(this, 'AiContentHttpApi', {
      apiName: 'AI Content Monetization HTTP API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.ANY],
        allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT', 'PAYMENT-SIGNATURE']
      }
    });

    // Lambda integrations
    const estimatorIntegration = new integrations.HttpLambdaIntegration('EstimatorIntegration', estimatorLambda);
    const sellerIntegration = new integrations.HttpLambdaIntegration('SellerIntegration', sellerLambda);

    // Routes
    httpApi.addRoutes({
      path: '/estimate',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: estimatorIntegration
    });

    httpApi.addRoutes({
      path: '/generate',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: sellerIntegration
    });

    httpApi.addRoutes({
      path: '/health',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: sellerIntegration
    });

    // S3 bucket for images with SSL enforcement
    const imagesBucket = new s3.Bucket(this, 'ImagesBucket', {
      lifecycleRules: [{ 
        expiration: cdk.Duration.days(1)
      }],
      cors: [{
        allowedOrigins: ['*'],
        allowedMethods: [s3.HttpMethods.GET],
        allowedHeaders: ['*']
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true
    });

    // DynamoDB table for WebSocket connections
    const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
    });

    // WebSocket Connect Lambda
    const wsConnectLambda = new nodejs.NodejsFunction(this, 'WSConnectLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: 'lambda/websocket/connect.js',
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName
      }
    });
    connectionsTable.grantWriteData(wsConnectLambda);

    // WebSocket Disconnect Lambda
    const wsDisconnectLambda = new nodejs.NodejsFunction(this, 'WSDisconnectLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: 'lambda/websocket/disconnect.js',
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName
      }
    });
    connectionsTable.grantWriteData(wsDisconnectLambda);

    // WebSocket Agent Lambda
    const wsAgentLambda = new nodejs.NodejsFunction(this, 'WSAgentLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: 'lambda/websocket/agent.js',
      handler: 'handler',
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        AGENT_RUNTIME_ARN: process.env.AGENT_RUNTIME_ARN || '',
        IMAGES_BUCKET: imagesBucket.bucketName
      }
    });
    connectionsTable.grantReadWriteData(wsAgentLambda);
    imagesBucket.grantPut(wsAgentLambda);
    imagesBucket.grantRead(wsAgentLambda);
    wsAgentLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:InvokeAgentRuntimeForUser'
      ],
      resources: ['*']
    }));
    wsAgentLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*']
    }));

    // WebSocket API
    const webSocketApi = new apigatewayv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: 'AI Content Monetization WebSocket API',
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('ConnectIntegration', wsConnectLambda)
      },
      disconnectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('DisconnectIntegration', wsDisconnectLambda)
      },
      defaultRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('DefaultIntegration', wsAgentLambda)
      }
    });

    const webSocketStage = new apigatewayv2.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true
    });

    // Grant WebSocket API permissions to agent Lambda
    wsAgentLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/*`]
    }));

    // Outputs
    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.url!,
      description: 'HTTP API Gateway URL'
    });

    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: webSocketStage.url,
      description: 'WebSocket API URL'
    });

    // CDK Nag Suppressions - access logging disabled to simplify deployment
    NagSuppressions.addResourceSuppressions(
      httpApi,
      [{ id: 'AwsSolutions-APIG1', reason: 'Access logging disabled to simplify deployment. This is a demo/PoC - enable logging for production.' }],
      true
    );
    NagSuppressions.addResourceSuppressions(
      webSocketApi,
      [{ id: 'AwsSolutions-APIG1', reason: 'Access logging disabled to simplify deployment. This is a demo/PoC - enable logging for production.' }],
      true
    );
  }
}
