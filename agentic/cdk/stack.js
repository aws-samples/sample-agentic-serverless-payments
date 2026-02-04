#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const nodejs = require('aws-cdk-lib/aws-lambda-nodejs');
const apigatewayv2 = require('aws-cdk-lib/aws-apigatewayv2');
const integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const ecr = require('aws-cdk-lib/aws-ecr');
const iam = require('aws-cdk-lib/aws-iam');
const codebuild = require('aws-cdk-lib/aws-codebuild');
const s3Assets = require('aws-cdk-lib/aws-s3-assets');
const bedrockagentcore = require('aws-cdk-lib/aws-bedrockagentcore');
const { AwsSolutionsChecks, NagSuppressions } = require('cdk-nag');

class X402GatewayStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // ========================================================================
    // X402 PAYMENT GATEWAY
    // ========================================================================

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

    // ========================================================================
    // AGENTCORE RUNTIME INFRASTRUCTURE
    // ========================================================================

    // ECR Repository for agent container
    const ecrRepository = new ecr.Repository(this, 'AgentECRRepository', {
      repositoryName: `${this.stackName.toLowerCase()}-agent`,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true
    });

    // S3 Asset for agent source code (exclude CDK artifacts to prevent recursion)
    const sourceAsset = new s3Assets.Asset(this, 'AgentSourceAsset', {
      path: '../',  // agentic folder
      exclude: [
        'cdk/**',
        '**/cdk.out/**',
        '**/node_modules/**',
        'venv/**',
        '**/__pycache__/**',
        '.bedrock_agentcore/**',
        '.bedrock_agentcore.yaml',
        '**/*.pyc',
        '.env',
        '.DS_Store',
        'lambda/node_modules/**'
      ]
    });

    // CodeBuild Role
    const codeBuildRole = new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        CodeBuildPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'CloudWatchLogs',
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents'
              ],
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*`]
            }),
            new iam.PolicyStatement({
              sid: 'ECRAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:GetAuthorizationToken',
                'ecr:PutImage',
                'ecr:InitiateLayerUpload',
                'ecr:UploadLayerPart',
                'ecr:CompleteLayerUpload'
              ],
              resources: [ecrRepository.repositoryArn, '*']
            }),
            new iam.PolicyStatement({
              sid: 'S3SourceAccess',
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:GetObjectVersion'],
              resources: [`${sourceAsset.bucket.bucketArn}/*`]
            })
          ]
        })
      }
    });

    // CodeBuild Project for ARM64 container
    const buildProject = new codebuild.Project(this, 'AgentImageBuildProject', {
      projectName: `${this.stackName}-agent-build`,
      description: 'Build agent Docker image for AgentCore Runtime',
      role: codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true
      },
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey
      }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com'
            ]
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Building the Docker image for agent ARM64...',
              'cp dockerfile-sample Dockerfile',
              'docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
              'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG'
            ]
          },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing the Docker image...',
              'docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG',
              'echo ARM64 Docker image pushed successfully'
            ]
          }
        }
      }),
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: this.region },
        AWS_ACCOUNT_ID: { value: this.account },
        IMAGE_REPO_NAME: { value: ecrRepository.repositoryName },
        IMAGE_TAG: { value: 'latest' }
      }
    });

    // Lambda function to trigger CodeBuild
    const buildTriggerFunction = new lambda.Function(this, 'BuildTriggerFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(15),
      code: lambda.Code.fromInline(`
import boto3
import json
import logging
import time
import urllib3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SUCCESS = "SUCCESS"
FAILED = "FAILED"

def send_response(event, context, status, data, physical_id=None, reason=None):
    response_url = event['ResponseURL']
    response_body = {
        'Status': status,
        'Reason': reason or f"See CloudWatch Log Stream: {context.log_stream_name}",
        'PhysicalResourceId': physical_id or context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'NoEcho': False,
        'Data': data
    }
    json_body = json.dumps(response_body)
    headers = {'content-type': '', 'content-length': str(len(json_body))}
    try:
        http = urllib3.PoolManager()
        http.request('PUT', response_url, headers=headers, body=json_body)
    except Exception as e:
        logger.error(f"Failed to send response: {e}")

def handler(event, context):
    logger.info(f"Received event: {json.dumps(event)}")
    try:
        if event['RequestType'] == 'Delete':
            send_response(event, context, SUCCESS, {})
            return

        project_name = event['ResourceProperties']['ProjectName']
        codebuild = boto3.client('codebuild')

        response = codebuild.start_build(projectName=project_name)
        build_id = response['build']['id']
        logger.info(f"Started build: {build_id}")

        max_wait = context.get_remaining_time_in_millis() / 1000 - 30
        start = time.time()

        while True:
            if time.time() - start > max_wait:
                send_response(event, context, FAILED, {'Error': 'Build timeout'})
                return

            build_resp = codebuild.batch_get_builds(ids=[build_id])
            status = build_resp['builds'][0]['buildStatus']

            if status == 'SUCCEEDED':
                logger.info(f"Build {build_id} succeeded")
                send_response(event, context, SUCCESS, {'BuildId': build_id})
                return
            elif status in ['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT']:
                logger.error(f"Build {build_id} failed: {status}")
                send_response(event, context, FAILED, {'Error': f'Build failed: {status}'})
                return

            logger.info(f"Build status: {status}")
            time.sleep(30)

    except Exception as e:
        logger.error(f"Error: {e}")
        send_response(event, context, FAILED, {'Error': str(e)})
`),
      initialPolicy: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
          resources: [buildProject.projectArn]
        })
      ]
    });

    // Custom Resource to trigger build
    const triggerBuild = new cdk.CustomResource(this, 'TriggerImageBuild', {
      serviceToken: buildTriggerFunction.functionArn,
      properties: {
        ProjectName: buildProject.projectName
      }
    });

    // ========================================================================
    // AGENTCORE EXECUTION ROLE
    // ========================================================================

    const agentExecutionRole = new iam.Role(this, 'AgentExecutionRole', {
      roleName: `${this.stackName}-AgentCoreExecutionRole`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess')
      ],
      inlinePolicies: {
        AgentCorePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'ECRImageAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:BatchGetImage',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchCheckLayerAvailability'
              ],
              resources: [ecrRepository.repositoryArn]
            }),
            new iam.PolicyStatement({
              sid: 'ECRTokenAccess',
              effect: iam.Effect.ALLOW,
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*']
            }),
            new iam.PolicyStatement({
              sid: 'CloudWatchLogs',
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:DescribeLogStreams',
                'logs:CreateLogGroup',
                'logs:DescribeLogGroups',
                'logs:CreateLogStream',
                'logs:PutLogEvents'
              ],
              resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`]
            }),
            new iam.PolicyStatement({
              sid: 'XRayTracing',
              effect: iam.Effect.ALLOW,
              actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords',
                'xray:GetSamplingRules',
                'xray:GetSamplingTargets'
              ],
              resources: ['*']
            }),
            new iam.PolicyStatement({
              sid: 'CloudWatchMetrics',
              effect: iam.Effect.ALLOW,
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: {
                StringEquals: {
                  'cloudwatch:namespace': 'bedrock-agentcore'
                }
              }
            }),
            new iam.PolicyStatement({
              sid: 'GetAgentAccessToken',
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock-agentcore:GetWorkloadAccessToken',
                'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
                'bedrock-agentcore:GetWorkloadAccessTokenForUserId'
              ],
              resources: [
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`
              ]
            }),
            new iam.PolicyStatement({
              sid: 'AgentCoreMemoryAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                'bedrock-agentcore:ListEvents',
                'bedrock-agentcore:CreateEvent',
                'bedrock-agentcore:GetEvent',
                'bedrock-agentcore:DeleteEvent',
                'bedrock-agentcore:ListMemories',
                'bedrock-agentcore:GetMemory'
              ],
              resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`]
            })
          ]
        })
      }
    });

    // ========================================================================
    // AGENTCORE MEMORY (Short-term memory)
    // ========================================================================

    const agentMemory = new bedrockagentcore.CfnMemory(this, 'AgentMemory', {
      name: 'x402_payment_agent_memory',
      description: 'Short-term memory for x402 payment agent',
      eventExpiryDuration: 30  // days
    });

    // ========================================================================
    // AGENTCORE RUNTIME
    // ========================================================================

    const agentRuntime = new bedrockagentcore.CfnRuntime(this, 'AgentRuntime', {
      agentRuntimeName: 'x402_payment_agent',
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: `${ecrRepository.repositoryUri}:latest`
        }
      },
      roleArn: agentExecutionRole.roleArn,
      networkConfiguration: {
        networkMode: 'PUBLIC'
      },
      protocolConfiguration: 'HTTP',
      description: 'x402 Payment Agent Runtime',
      environmentVariables: {
        CDP_API_KEY_ID: process.env.CDP_API_KEY_ID || '',
        CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET || '',
        CDP_WALLET_SECRET: process.env.CDP_WALLET_SECRET || '',
        NETWORK_ID: process.env.NETWORK_ID || 'base-sepolia',
        RPC_URL: process.env.RPC_URL || 'https://sepolia.base.org',
        USDC_CONTRACT: process.env.USDC_CONTRACT || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        SELLER_WALLET: process.env.SELLER_WALLET || '',
        GATEWAY_URL: httpApi.url,
        AWS_REGION: this.region,
        BEDROCK_AGENTCORE_MEMORY_ID: agentMemory.attrMemoryId
      }
    });

    // Ensure runtime waits for container build
    agentRuntime.node.addDependency(triggerBuild);
    agentRuntime.node.addDependency(agentMemory);

    // ========================================================================
    // CDK NAG SUPPRESSIONS
    // ========================================================================

    NagSuppressions.addResourceSuppressions(
      paymentLambda,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs. This is a demo/PoC with minimal permissions.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'NodejsFunction uses a recent Node.js runtime. This is acceptable for demo/PoC.'
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

    NagSuppressions.addResourceSuppressions(
      agentExecutionRole,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AmazonBedrockFullAccess is required for agent to invoke Bedrock models. This is a demo/PoC.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonBedrockFullAccess']
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permissions required for ECR auth token, X-Ray, CloudWatch metrics, and AgentCore resources. These are standard AgentCore requirements.',
          appliesTo: [
            'Resource::*',
            `Resource::arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
            `Resource::arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
            `Resource::arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`
          ]
        }
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      codeBuildRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CodeBuild requires wildcard for logs and S3 asset access. These are scoped to specific resources.',
          appliesTo: [
            'Resource::*',
            `Resource::arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/*`,
            `Resource::${sourceAsset.bucket.bucketArn}/*`,
            'Action::s3:GetBucket*',
            'Action::s3:GetObject*',
            'Action::s3:List*',
            { regex: '/^Resource::arn:aws:logs:.*:log-group:/aws/codebuild/<AgentImageBuildProject.*>:\\*$/' },
            { regex: '/^Resource::arn:aws:codebuild:.*:report-group/<AgentImageBuildProject.*>-\\*$/' }
          ]
        }
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      buildProject,
      [
        {
          id: 'AwsSolutions-CB4',
          reason: 'KMS encryption not required for demo/PoC. CodeBuild uses default encryption.'
        }
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      buildTriggerFunction,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Python 3.11 is a recent runtime version. This is acceptable for demo/PoC.'
        }
      ],
      true
    );

    // ========================================================================
    // OUTPUTS
    // ========================================================================

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.url,
      description: 'API Gateway URL (no auth required)'
    });

    new cdk.CfnOutput(this, 'LambdaArn', {
      value: paymentLambda.functionArn,
      description: 'Payment middleware Lambda ARN'
    });

    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: agentRuntime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN'
    });

    new cdk.CfnOutput(this, 'AgentRuntimeId', {
      value: agentRuntime.attrAgentRuntimeId,
      description: 'AgentCore Runtime ID'
    });

    new cdk.CfnOutput(this, 'MemoryId', {
      value: agentMemory.attrMemoryId,
      description: 'AgentCore Memory ID'
    });

    new cdk.CfnOutput(this, 'ECRRepositoryUri', {
      value: ecrRepository.repositoryUri,
      description: 'ECR Repository URI'
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
