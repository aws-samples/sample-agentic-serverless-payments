#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const nodejs = require('aws-cdk-lib/aws-lambda-nodejs');
const apigatewayv2 = require('aws-cdk-lib/aws-apigatewayv2');
const integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const { AwsSolutionsChecks, NagSuppressions } = require('cdk-nag');

class X402GatewayStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const paymentLambda = new nodejs.NodejsFunction(this, 'PaymentMiddleware', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: '../lambda/seller.js',
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        SELLER_WALLET: process.env.SELLER_WALLET,
        GATEWAY_URL: ''
      }
    });

    const httpApi = new apigatewayv2.HttpApi(this, 'X402HttpApi', {
      apiName: 'x402-payment-gateway',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.ANY],
        allowHeaders: ['*']
      }
    });

    paymentLambda.addEnvironment('GATEWAY_URL', httpApi.url);

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      paymentLambda
    );

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: lambdaIntegration
    });

    // CDK Nag Suppressions with justifications
    NagSuppressions.addResourceSuppressions(
      paymentLambda,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs. This is a demo/PoC with minimal permissions.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
        }
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      httpApi,
      [
        {
          id: 'AwsSolutions-APIG1',
          reason: 'Access logging disabled to simplify deployment. This is a demo/PoC - enable logging for production.'
        },
        {
          id: 'AwsSolutions-APIG4',
          reason: 'x402 payment protocol uses cryptographic payment signatures (PAYMENT-SIGNATURE header) for authorization instead of traditional API auth. This is by design per x402 spec.'
        }
      ],
      true
    );

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.url,
      description: 'API Gateway URL (no auth required)'
    });

    new cdk.CfnOutput(this, 'LambdaArn', {
      value: paymentLambda.functionArn,
      description: 'Payment middleware Lambda ARN'
    });
  }
}

const app = new cdk.App();

// Apply CDK Nag for security best practices
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

new X402GatewayStack(app, 'X402GatewayStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1'
  }
});
