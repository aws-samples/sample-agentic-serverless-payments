import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
// NodejsFunction removed — using plain lambda.Function with pre-installed node_modules
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2auth from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2int from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { NagSuppressions } from "cdk-nag";
import * as path from "path";

// AgentCore Runtime endpoint — used by the agent WebSocket/invoke lambda to
// connect to the Runtime service. Defaults to the region's AgentCore endpoint.
// Control-plane and data-plane endpoints are resolved from the region by
// boto3, so no CP/DP endpoint config is needed.
const RUNTIME_ENDPOINT = process.env.RUNTIME_ENDPOINT || `https://bedrock-agentcore.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com`;

export class PaymentAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Cognito ──
    // Self-signup is allowed: anyone can register through the frontend and
    // the post-confirmation trigger below puts them in the `user` group
    // automatically. The `admin` group is populated manually (console/CLI)
    // and never via the self-signup flow, so a new signup can only ever
    // produce a `user`-group account.
    const userPool = new cognito.UserPool(this, "PaymentUserPool", {
      userPoolName: "agentcore-payments-users", selfSignUpEnabled: true,
      signInAliases: { email: true }, autoVerify: { email: true },
      passwordPolicy: { minLength: 8, requireUppercase: true, requireDigits: true, requireSymbols: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // L1 drift-proofing: force-reassert self-signup on every deploy so a
    // console edit of AdminCreateUserConfig can't silently break the signup
    // page for end users. CDK's `selfSignUpEnabled` sets this once at create
    // time; this override rewrites it on every `cdk deploy`.
    (userPool.node.defaultChild as cognito.CfnUserPool).adminCreateUserConfig = {
      allowAdminCreateUserOnly: false,
    };

    const userPoolClient = userPool.addClient("PaymentWebClient", {
      userPoolClientName: "payment-web-client",
      authFlows: { userSrp: true }, generateSecret: false,
    });
    new cognito.CfnUserPoolGroup(this, "AdminGroup", { userPoolId: userPool.userPoolId, groupName: "admin", description: "Admin users" });
    new cognito.CfnUserPoolGroup(this, "UserGroup", { userPoolId: userPool.userPoolId, groupName: "user", description: "Regular users" });

    // Demo admin credentials. Self-signup only ever produces a `user`-group
    // account, so the app ships with one seeded `admin`. The username is fixed;
    // the password is generated once by CloudFormation and stored in Secrets
    // Manager (never in the repo, logs, or stack outputs). setup_backend.sh
    // reads it to create the Cognito admin, and the deployer retrieves it from
    // Secrets Manager using the AdminCredentialsSecretName output. Generated on
    // create only, so it persists unchanged across redeploys.
    const adminCredentialsSecret = new secretsmanager.Secret(this, "DemoAdminCredentials", {
      description: "Demo admin login for the AgentCore payments app (username fixed, password generated once).",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "demo@agentcore-payments.dev" }),
        generateStringKey: "password",
        passwordLength: 20,
        // Exclude punctuation to avoid shell-escaping issues when the setup
        // script passes the password to the AWS CLI; the Cognito policy only
        // requires length, an uppercase letter, and a digit.
        excludePunctuation: true,
        requireEachIncludedType: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Post-confirmation trigger: auto-assign self-signed-up users to "user" group
    const postConfirmRole = new iam.Role(this, "PostConfirmRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    postConfirmRole.addToPolicy(new iam.PolicyStatement({
      actions: ["cognito-idp:AdminAddUserToGroup"],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`],
    }));
    const postConfirmFn = new lambda.Function(this, "PostConfirmFn", {
      functionName: "agentcore-payments-post-confirm",
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "index.handler",
      role: postConfirmRole,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      code: lambda.Code.fromInline(`
import boto3

cognito = boto3.client("cognito-idp")

def handler(event, context):
    if event.get("triggerSource") == "PostConfirmation_ConfirmSignUp":
        cognito.admin_add_user_to_group(
            UserPoolId=event["userPoolId"],
            Username=event["userName"],
            GroupName="user",
        )
    return event
`),
    });
    userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postConfirmFn);

    // ── S3 Media Bucket (presigned URL delivery for images/audio) ──
    const mediaBucket = new cdk.aws_s3.Bucket(this, "MediaBucket", {
      bucketName: `agentcore-payments-media-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    // ── S3 Library Bucket (persistent per-buyer digital library) ──
    // Keyed by Cognito sub: library/{userId}/... — holds digital purchases and
    // saved generated media. Shared by the agent runtime (saves generated
    // images) and the storefront order service (saves purchased files), and
    // read back by the authenticated Library page. No expiry (unlike media).
    const libraryBucket = new cdk.aws_s3.Bucket(this, "StorefrontLibraryBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    // ── IAM: Payment Manager Service Role (must be defined before adminCpRole uses it) ──
    const paymentManagerRole = new iam.Role(this, "PaymentManagerServiceRole", {
      roleName: "AgentCorePayments-ManagerRole",
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        new iam.ServicePrincipal("preprod.genesis-service.aws.internal"),
        new iam.ServicePrincipal("developer.genesis-service.aws.internal"),
      ),
    });
    paymentManagerRole.addToPolicy(new iam.PolicyStatement({
      // For production, replace "bedrock-agentcore:*" with the specific actions
      // this role needs (e.g. GetWorkloadAccessToken and the token-vault /
      // credential-provider operations). The wildcard is used here because the
      // AgentCore Payments APIs are in preview and the action set is still
      // evolving; the resource list below is already scoped to this account's
      // default token vault and workload-identity directory.
      effect: iam.Effect.ALLOW, actions: [
        "bedrock-agentcore:*",
        "bedrock-agentcore:GetWorkloadAccessToken",
      ], resources: [
        `arn:aws:bedrock-agentcore:*:${this.account}:token-vault/default`,
        `arn:aws:bedrock-agentcore:*:${this.account}:token-vault/default/*`,
        `arn:aws:bedrock-agentcore:*:${this.account}:token-vault/default/paymentcredentialprovider/*`,
        `arn:aws:bedrock-agentcore:*:${this.account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:*:${this.account}:workload-identity-directory/default/workload-identity/*`,
      ],
    }));
    paymentManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW, actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:*:${this.account}:secret:*`],
    }));
    paymentManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW, actions: ["sts:SetContext"],
      resources: [`arn:aws:sts::${this.account}:self`],
    }));

    // ── IAM: Admin CP Lambda Role ──
    const adminCpRole = new iam.Role(this, "AdminControlPlaneRole", {
      roleName: "AgentCorePayments-AdminCP", assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    adminCpRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: [
      "bedrock-agentcore:CreatePaymentCredentialProvider", "bedrock-agentcore:GetPaymentCredentialProvider",
      "bedrock-agentcore:ListPaymentCredentialProviders", "bedrock-agentcore:UpdatePaymentCredentialProvider",
      "bedrock-agentcore:DeletePaymentCredentialProvider",
      "bedrock-agentcore:CreatePaymentManager", "bedrock-agentcore:GetPaymentManager",
      "bedrock-agentcore:ListPaymentManagers", "bedrock-agentcore:UpdatePaymentManager",
      "bedrock-agentcore:DeletePaymentManager", "bedrock-agentcore:CreatePaymentConnector",
      "bedrock-agentcore:GetPaymentConnector", "bedrock-agentcore:ListPaymentConnectors",
      "bedrock-agentcore:UpdatePaymentConnector", "bedrock-agentcore:DeletePaymentConnector",
      "bedrock-agentcore:CreateTokenVault", "bedrock-agentcore:GetTokenVault",
      "bedrock-agentcore:ListTokenVaults", "bedrock-agentcore:DeleteTokenVault",
    ], resources: ["*"] }));
    adminCpRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: [
      "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret",
      "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
      // Scoped to secrets in this account/region. AgentCore Identity generates
      // the credential-provider secret names (with random suffixes), so we
      // cannot pin an exact name, but we constrain to this account+region.
    ], resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`] }));
    adminCpRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: [
      "iam:PassRole",
    ], resources: [paymentManagerRole.roleArn] }));

    // ── IAM: User DP Lambda Role ──
    const userDpRole = new iam.Role(this, "UserDataPlaneRole", {
      roleName: "AgentCorePayments-UserDP", assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    userDpRole.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: [
      "bedrock-agentcore:CreatePaymentInstrument", "bedrock-agentcore:GetPaymentInstrument",
      "bedrock-agentcore:ListPaymentInstruments", "bedrock-agentcore:GetPaymentInstrumentBalance",
      "bedrock-agentcore:DeletePaymentInstrument",
      "bedrock-agentcore:CreatePaymentSession",
      "bedrock-agentcore:GetPaymentSession", "bedrock-agentcore:ListPaymentSessions",
      "bedrock-agentcore:DeletePaymentSession",
      "bedrock-agentcore:ProcessPayment",
      "bedrock-agentcore:CreateWorkloadIdentity", "bedrock-agentcore:GetWorkloadIdentity",
      "bedrock-agentcore:ListWorkloadIdentities", "bedrock-agentcore:DeleteWorkloadIdentity",
      "bedrock-agentcore:GetWorkloadAccessToken",
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:InvokeAgentRuntimeWithWebsocketStream",
    ], resources: ["*"] }));

    // ── Lambda Layer + Functions ──
    // The shared layer ships our helper modules (agentcore_client, response)
    // plus a GA-capable boto3/botocore. The Lambda runtime bundles an older
    // boto3 that predates the AgentCore Payments APIs, so the setup script
    // pip-installs a pinned boto3 into lambdas/shared/python/ (which Lambda
    // places ahead of the runtime SDK on sys.path). No Docker required —
    // build happens in the cloud via CodeBuild for the agent image and via
    // a plain pip install for this pure-Python layer.
    const sharedLayer = new lambda.LayerVersion(this, "SharedLayer", {
      layerVersionName: "agentcore-payments-shared",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambdas", "shared")),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_13],
    });
    const lambdasDir = path.join(__dirname, "..", "lambdas");
    const commonEnv = {
      PAYMENT_MANAGER_ROLE_ARN: paymentManagerRole.roleArn,
    };
    const lProps = { runtime: lambda.Runtime.PYTHON_3_13, layers: [sharedLayer], environment: commonEnv, timeout: cdk.Duration.seconds(30), memorySize: 1024 };

    const credentialProvidersFn = new lambda.Function(this, "CredentialProvidersFn", { ...lProps, functionName: "agentcore-payments-credential-providers", handler: "index.handler", code: lambda.Code.fromAsset(path.join(lambdasDir, "admin", "credential_providers")), role: adminCpRole });
    const paymentManagersFn = new lambda.Function(this, "PaymentManagersFn", { ...lProps, functionName: "agentcore-payments-managers", handler: "index.handler", code: lambda.Code.fromAsset(path.join(lambdasDir, "admin", "payment_managers")), role: adminCpRole });
    const paymentConnectorsFn = new lambda.Function(this, "PaymentConnectorsFn", { ...lProps, functionName: "agentcore-payments-connectors", handler: "index.handler", code: lambda.Code.fromAsset(path.join(lambdasDir, "admin", "payment_connectors")), role: adminCpRole });
    const instrumentsFn = new lambda.Function(this, "InstrumentsFn", { ...lProps, functionName: "agentcore-payments-instruments", handler: "index.handler", code: lambda.Code.fromAsset(path.join(lambdasDir, "user", "instruments")), role: userDpRole });
    const sessionsFn = new lambda.Function(this, "SessionsFn", { ...lProps, functionName: "agentcore-payments-sessions", handler: "index.handler", code: lambda.Code.fromAsset(path.join(lambdasDir, "user", "sessions")), role: userDpRole });
    const agentWsFn = new lambda.Function(this, "AgentWsFn", { ...lProps, functionName: "agentcore-payments-agent-ws", handler: "index.handler", code: lambda.Code.fromAsset(path.join(lambdasDir, "user", "agent")), role: userDpRole, timeout: cdk.Duration.seconds(90) });

    // Payment-options bootstrap (user-scoped, READ-ONLY): lets a non-admin user
    // discover the platform's manager ARN + connector id needed to create their
    // first instrument/session, WITHOUT exposing the sensitive admin endpoints.
    // Its own role grants only the two list ops — strict least privilege.
    const paymentOptionsRole = new iam.Role(this, "PaymentOptionsRole", {
      roleName: "AgentCorePayments-UserPaymentOptions",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    paymentOptionsRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "bedrock-agentcore:ListPaymentManagers",
        "bedrock-agentcore:ListPaymentConnectors",
      ],
      resources: ["*"],
    }));
    const paymentOptionsFn = new lambda.Function(this, "PaymentOptionsFn", { ...lProps, functionName: "agentcore-payments-payment-options", handler: "index.handler", code: lambda.Code.fromAsset(path.join(lambdasDir, "user", "payment_options")), role: paymentOptionsRole });

    // ── API Gateway ──
    const httpApi = new apigwv2.HttpApi(this, "PaymentApi", {
      apiName: "agentcore-payments-api",
      corsPreflight: { allowOrigins: ["*"], allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.DELETE, apigwv2.CorsHttpMethod.OPTIONS], allowHeaders: ["Content-Type", "Authorization"] },
    });
    const authorizer = new apigwv2auth.HttpJwtAuthorizer("CognitoAuthorizer", `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`, { jwtAudience: [userPoolClient.userPoolClientId], identitySource: ["$request.header.Authorization"] });

    const cpI = new apigwv2int.HttpLambdaIntegration("CredProvInt", credentialProvidersFn);
    httpApi.addRoutes({ path: "/admin/credential-providers", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST], integration: cpI, authorizer });
    httpApi.addRoutes({ path: "/admin/credential-providers/{id}", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE], integration: cpI, authorizer });
    const mI = new apigwv2int.HttpLambdaIntegration("ManagersInt", paymentManagersFn);
    httpApi.addRoutes({ path: "/admin/managers", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST], integration: mI, authorizer });
    httpApi.addRoutes({ path: "/admin/managers/{id}", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE], integration: mI, authorizer });
    const cI = new apigwv2int.HttpLambdaIntegration("ConnectorsInt", paymentConnectorsFn);
    httpApi.addRoutes({ path: "/admin/connectors", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST], integration: cI, authorizer });
    httpApi.addRoutes({ path: "/admin/connectors/{id}", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE], integration: cI, authorizer });
    const iI = new apigwv2int.HttpLambdaIntegration("InstrumentsInt", instrumentsFn);
    httpApi.addRoutes({ path: "/user/instruments", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST], integration: iI, authorizer });
    httpApi.addRoutes({ path: "/user/instruments/{id}", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE], integration: iI, authorizer });
    httpApi.addRoutes({ path: "/user/instruments/{id}/balance", methods: [apigwv2.HttpMethod.GET], integration: iI, authorizer });
    const sI = new apigwv2int.HttpLambdaIntegration("SessionsInt", sessionsFn);
    httpApi.addRoutes({ path: "/user/sessions", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST], integration: sI, authorizer });
    httpApi.addRoutes({ path: "/user/sessions/{id}", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE], integration: sI, authorizer });
    const aI = new apigwv2int.HttpLambdaIntegration("AgentWsInt", agentWsFn);
    httpApi.addRoutes({ path: "/user/agent/ws-url", methods: [apigwv2.HttpMethod.GET], integration: aI, authorizer });
    httpApi.addRoutes({ path: "/user/agent/invoke", methods: [apigwv2.HttpMethod.POST], integration: aI, authorizer });
    const poI = new apigwv2int.HttpLambdaIntegration("PaymentOptionsInt", paymentOptionsFn);
    httpApi.addRoutes({ path: "/user/payment-options", methods: [apigwv2.HttpMethod.GET], integration: poI, authorizer });

    // ══════════════════════════════════════════════════════════════════
    // AGENT RUNTIME INFRASTRUCTURE
    // ══════════════════════════════════════════════════════════════════

    // ── ECR Repository ──
    const agentRepo = new ecr.Repository(this, "AgentEcrRepo", {
      repositoryName: "agentcore-payments-agent",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 5, description: "Keep last 5 images" }],
    });

    // ── CodeBuild Source: S3 asset from local payment-agent/ directory ──
    // CDK zips and uploads payment-agent/ to S3 automatically on deploy.
    // No GitHub/CodeCommit/etc required — works for any user who clones the repo.
    const agentSourceAsset = new cdk.aws_s3_assets.Asset(this, "AgentSourceAsset", {
      path: path.join(__dirname, "..", "..", "payment-agent"),
    });

    // ── CodeBuild Project (ARM64 for Graviton-based Runtime) ──
    const buildProject = new codebuild.Project(this, "AgentBuildProject", {
      projectName: "agentcore-payments-agent-build",
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // Docker-in-Docker
      },
      source: codebuild.Source.s3({
        bucket: agentSourceAsset.bucket,
        path: agentSourceAsset.s3ObjectKey,
      }),
      environmentVariables: {
        AWS_ACCOUNT_ID: { value: this.account },
        AWS_DEFAULT_REGION: { value: this.region },
        ECR_REPO_URI: { value: agentRepo.repositoryUri },
        IMAGE_TAG: { value: agentSourceAsset.assetHash },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              "echo Logging in to ECR...",
              "aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com",
            ],
          },
          build: {
            commands: [
              "echo Building agent image...",
              "docker build -t $ECR_REPO_URI:$IMAGE_TAG .",
            ],
          },
          post_build: {
            commands: [
              "echo Pushing to ECR...",
              "docker push $ECR_REPO_URI:$IMAGE_TAG",
              "docker tag $ECR_REPO_URI:$IMAGE_TAG $ECR_REPO_URI:latest",
              "docker push $ECR_REPO_URI:latest",
              'echo \'{"imageUri":"\'$ECR_REPO_URI:$IMAGE_TAG\'"}\'',
            ],
          },
        },
      }),
    });

    // Grant CodeBuild push access to ECR
    agentRepo.grantPullPush(buildProject);

    // ── Build Trigger Lambda (Custom Resource) ──
    // Starts CodeBuild and polls until complete so the Runtime resource
    // only gets created after the container image exists in ECR.
    const buildTriggerRole = new iam.Role(this, "BuildTriggerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    buildTriggerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
      resources: [buildProject.projectArn],
    }));

    const buildTriggerFn = new lambda.Function(this, "BuildTriggerFn", {
      functionName: "agentcore-payments-build-trigger",
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "index.handler",
      role: buildTriggerRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 128,
      code: lambda.Code.fromInline(`
import json, time, boto3, urllib.request

def handler(event, context):
    props = event.get("ResourceProperties", {})
    project_name = props.get("ProjectName", "")
    response_url = event.get("ResponseURL", "")

    # Only build on Create/Update
    if event["RequestType"] == "Delete":
        return send_response(event, context, "SUCCESS", {"ImageBuilt": "skipped"})

    cb = boto3.client("codebuild")
    try:
        build = cb.start_build(projectName=project_name)
        build_id = build["build"]["id"]
        print(f"Started build: {build_id}")

        # Poll every 30s until complete (max ~14 min)
        for _ in range(28):
            time.sleep(30)
            result = cb.batch_get_builds(ids=[build_id])
            status = result["builds"][0]["buildStatus"]
            print(f"Build status: {status}")
            if status == "SUCCEEDED":
                return send_response(event, context, "SUCCESS", {"BuildId": build_id})
            elif status in ("FAILED", "FAULT", "STOPPED", "TIMED_OUT"):
                return send_response(event, context, "FAILED", {"Error": f"Build {status}"})

        return send_response(event, context, "FAILED", {"Error": "Build timed out"})
    except Exception as e:
        print(f"Error: {e}")
        return send_response(event, context, "FAILED", {"Error": str(e)})

def send_response(event, context, status, data):
    body = json.dumps({
        "Status": status,
        "Reason": json.dumps(data),
        "PhysicalResourceId": context.log_stream_name,
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": data,
    })
    req = urllib.request.Request(event["ResponseURL"], data=body.encode(), method="PUT",
                                 headers={"Content-Type": ""})
    urllib.request.urlopen(req)
`),
    });

    const triggerBuild = new cdk.CustomResource(this, "TriggerImageBuild", {
      serviceToken: buildTriggerFn.functionArn,
      properties: {
        ProjectName: buildProject.projectName,
        // Tied to the S3 asset hash — any change in payment-agent/ triggers a rebuild
        SourceHash: agentSourceAsset.assetHash,
      },
    });

    // ── Agent Execution Role ──
    const agentExecutionRole = new iam.Role(this, "AgentExecutionRole", {
      roleName: "AgentCorePayments-AgentExecution",
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        new iam.ServicePrincipal("preprod.genesis-service.aws.internal"),
        new iam.ServicePrincipal("developer.genesis-service.aws.internal"),
      ),
      // No managed policy — explicit permissions below
    });

    // ECR pull
    agentRepo.grantPull(agentExecutionRole);

    // Bedrock AgentCore full access (replaces managed policy)
    // For production, replace "bedrock-agentcore:*" on "*" with the specific
    // actions and resource ARNs the agent runtime requires. The wildcard is
    // used here because AgentCore Payments is in preview: the runtime creates
    // resources (sessions, memory, workload identities) with ARNs that are not
    // known at synth time and the preview action set is not yet resource-scopeable.
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock-agentcore:*"],
      resources: ["*"],
    }));

    // Bedrock model invocation (Claude Sonnet via cross-region inference
    // profile + Nova Sonic). The "us." inference profile load-balances across
    // multiple US regions, so the underlying InvokeModel call can land in
    // us-east-1, us-east-2, or us-west-2 — grant foundation-model + inference
    // -profile access across regions so routing never trips on IAM.
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));

    // CloudWatch Logs — the runtime writes its own log streams, AND the agent
    // wires AgentCore Payments "vended log delivery" at runtime (Payments →
    // CloudWatch Logs). The delivery source/destination/delivery objects are
    // not resource-scopeable on Describe*/Put*Delivery* APIs, so those stay
    // wildcarded; the log-group writes target the agentcore log prefix.
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: "CloudWatchLogsVendedDelivery",
      actions: [
        "logs:CreateLogGroup", "logs:CreateLogStream",
        "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams",
        "logs:CreateDelivery", "logs:GetDelivery", "logs:DeleteDelivery",
        "logs:PutDeliverySource", "logs:GetDeliverySource", "logs:DeleteDeliverySource",
        "logs:PutDeliveryDestination", "logs:GetDeliveryDestination", "logs:DeleteDeliveryDestination",
        "logs:DescribeResourcePolicies", "logs:PutResourcePolicy", "logs:DeleteResourcePolicy",
        "logs:PutRetentionPolicy",
      ],
      resources: ["*"],
    }));

    // AgentCore Payments vended log delivery authorization — what lets the
    // PaymentManager emit its transaction logs through the pipeline above.
    // CloudWatch checks both actions implicitly when put_delivery_source runs
    // against a Payment Manager ARN (product-level + service-level gate).
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: "PaymentsVendedLogDelivery",
      actions: [
        "bedrock-agentcore:PaymentsAllowVendedLogDeliveryForResource",
        "bedrock-agentcore:AllowVendedLogDeliveryForResource",
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:payment-manager/*`,
      ],
    }));

    // X-Ray tracing
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "xray:PutTraceSegments", "xray:PutTelemetryRecords",
        "xray:GetSamplingRules", "xray:GetSamplingTargets",
      ],
      resources: ["*"],
    }));

    // CloudWatch metrics
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudwatch:PutMetricData"],
      resources: ["*"],
      conditions: { StringEquals: { "cloudwatch:namespace": "AgentCorePayments" } },
    }));

    // AgentCore workload identity tokens
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:CreateWorkloadIdentity",
        "bedrock-agentcore:GetWorkloadIdentity",
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/*`,
      ],
    }));

    // AgentCore Memory CRUD
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:CreateMemory",
        "bedrock-agentcore:GetMemory",
        "bedrock-agentcore:UpdateMemory",
        "bedrock-agentcore:DeleteMemory",
        "bedrock-agentcore:CreateMemoryRecord",
        "bedrock-agentcore:GetMemoryRecord",
        "bedrock-agentcore:SearchMemoryRecords",
        "bedrock-agentcore:DeleteMemoryRecord",
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/*`,
      ],
    }));

    // S3 Media Bucket (agent uploads images/audio, generates presigned GET URLs)
    mediaBucket.grantReadWrite(agentExecutionRole);
    // Library bucket (agent saves generated images to the buyer's library)
    libraryBucket.grantReadWrite(agentExecutionRole);

    // AgentCore Payment DP permissions (ProcessPayment, GetPaymentSession)
    agentExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:ProcessPayment",
        "bedrock-agentcore:GetPaymentSession",
        "bedrock-agentcore:GetPaymentInstrument",
      ],
      resources: ["*"],
    }));

    // ── AgentCore Memory ──
    const agentMemory = new bedrockagentcore.CfnMemory(this, "AgentMemory", {
      name: "agentcore_payments_memory",
      description: "Persistent conversation memory for the x402 payment agent",
      eventExpiryDuration: 30,
    });

    // ── AgentCore Runtime ──
    const agentRuntime = new bedrockagentcore.CfnRuntime(this, "AgentRuntime", {
      agentRuntimeName: "agentcore_payments_runtime",
      description: "x402 Payment Agent with Nova Sonic voice and AgentCore Payments",
      roleArn: agentExecutionRole.roleArn,
      networkConfiguration: {
        networkMode: "PUBLIC",
      },
      protocolConfiguration: "HTTP",
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: `${agentRepo.repositoryUri}:${agentSourceAsset.assetHash}`,
        },
      },
      environmentVariables: {
        AWS_REGION: this.region,
        AWS_ACCOUNT_ID: this.account,
        PAYMENT_MANAGER_ARN: paymentManagerRole.roleArn.replace(":iam:", ":bedrock-agentcore:").replace(":role/", ":payment-manager/"),
        BEDROCK_AGENTCORE_MEMORY_ID: agentMemory.attrMemoryId,
        // Claude Sonnet 4.6 — strong tool-use for the storefront buying agent
        TEXT_MODEL_ID: process.env.TEXT_MODEL_ID || "us.anthropic.claude-sonnet-4-6",
        VOICE_MODEL_ID: process.env.VOICE_MODEL_ID || "amazon.nova-2-sonic-v1:0",
        SELLER_API_URL: process.env.SELLER_API_URL || "",
        STOREFRONT_API_URL: process.env.STOREFRONT_API_URL || "",
        MEDIA_BUCKET: mediaBucket.bucketName,
        LIBRARY_BUCKET: libraryBucket.bucketName,
        // Observability: enable AgentCore Payments vended log delivery wiring
        // (Payments transaction logs → CloudWatch Logs) at runtime.
        ENABLE_VENDED_LOG_DELIVERY: process.env.ENABLE_VENDED_LOG_DELIVERY || "1",
        // Payments plugin is the primary x402 path (auto 402 -> pay -> retry)
        // and tags spans with this agent name, which populates the Payments
        // observability dashboard (Agents/Managers/Connectors counters).
        ENABLE_PAYMENTS_PLUGIN: process.env.ENABLE_PAYMENTS_PLUGIN || "1",
        PAYMENTS_AGENT_NAME: process.env.PAYMENTS_AGENT_NAME || "agentcore-payments-agent",
        OTEL_SERVICE_NAME: "agentcore-payments-agent",
      },
    });

    // Runtime depends on the image being built first
    agentRuntime.node.addDependency(triggerBuild);
    agentRuntime.node.addDependency(agentMemory);

    // Inject runtime ARN into the presigned URL Lambda
    agentWsFn.addEnvironment("AGENT_RUNTIME_ARN", agentRuntime.attrAgentRuntimeArn);
    // Point the agent ws lambda at the AgentCore Runtime endpoint rather than
    // the payments data-plane endpoint.
    agentWsFn.addEnvironment("RUNTIME_ENDPOINT", RUNTIME_ENDPOINT);

    // ── Observability ──
    // Two layers are active:
    //   1. ADOT auto-instrumentation in the agent container exports traces,
    //      logs, and metrics via OTLP to the AgentCore Runtime collector.
    //   2. AgentCore Payments "vended log delivery": on first invocation the
    //      agent wires the PaymentManager's transaction logs into a CloudWatch
    //      Logs group (/bedrock-agentcore/payments/<managerId>) via
    //      put_delivery_source/destination + create_delivery. The IAM grants
    //      above (CloudWatchLogsVendedDelivery + PaymentsVendedLogDelivery)
    //      authorize it; ENABLE_VENDED_LOG_DELIVERY toggles it.
    // Runtime-level CFN log delivery isn't used (RuntimeArn isn't a CFN return
    // attribute), so the wiring is done in-agent and is idempotent per manager.

    // ══════════════════════════════════════════════════════════════════
    // SELLER LAMBDAS (x402 paid endpoints)
    // ══════════════════════════════════════════════════════════════════

    // Seller config table — holds the single AgentCore-provisioned seller
    // identity (payout wallet addresses) created from the admin Seller Setup
    // page. Created here (before the seller lambdas) so every paid seller
    // endpoint — image-gen as well as the storefront — resolves its payTo from
    // the same provisioned wallet at request time, instead of static deploy-time
    // env addresses. The storefront section below reuses this same table.
    const sellerConfigTable = new dynamodb.Table(this, "SellerConfigTable", {
      tableName: "StorefrontSellerConfig",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sellerEnv = {
      SELLER_CONFIG_TABLE: sellerConfigTable.tableName,
      X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
      AWS_REGION_OVERRIDE: this.region,
    };

    // ── Image Gen Lambda (Nova Canvas) ──
    const imageGenRole = new iam.Role(this, "ImageGenRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    imageGenRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-canvas-v1:0`,
      ],
    }));

    const imageGenFn = new lambda.Function(this, "ImageGenFn", {
      functionName: "x402-seller-image-gen",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(lambdasDir, "sellers", "image-gen")),
      handler: "index.handler",
      role: imageGenRole,
      environment: sellerEnv,
      timeout: cdk.Duration.seconds(45),
      memorySize: 1024,
    });
    // image-gen resolves its payout wallet from the provisioned seller config.
    sellerConfigTable.grantReadData(imageGenFn);

    // ── Seller API Gateway (no Cognito — x402 payment IS the auth) ──
    const sellerApi = new apigwv2.HttpApi(this, "SellerApi", {
      apiName: "x402-sellers-api",
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["Content-Type", "X-Payment", "X-Payment-Response"],
      },
    });

    const imageInt = new apigwv2int.HttpLambdaIntegration("ImageGenInt", imageGenFn);
    sellerApi.addRoutes({ path: "/image-gen", methods: [apigwv2.HttpMethod.POST], integration: imageInt });
    sellerApi.addRoutes({ path: "/image-gen", methods: [apigwv2.HttpMethod.GET], integration: imageInt }); // health/discovery

    // Health check route (no payment)
    sellerApi.addRoutes({ path: "/health", methods: [apigwv2.HttpMethod.GET], integration: imageInt });

    // ══════════════════════════════════════════════════════════════════
    // AGENT-ECONOMY STOREFRONT — DynamoDB + Order/Product/Seller lambdas +
    // static storefront (S3 + CloudFront). x402 (HTTP 402) order endpoint,
    // seller-originated refunds governed by per-refund capped sessions.
    // ══════════════════════════════════════════════════════════════════

    // ── DynamoDB tables ──
    const productsTable = new dynamodb.Table(this, "ProductsTable", {
      tableName: "StorefrontProducts",
      partitionKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const ordersTable = new dynamodb.Table(this, "OrdersTable", {
      tableName: "StorefrontOrders",
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    ordersTable.addGlobalSecondaryIndex({
      indexName: "buyerUserId-index",
      partitionKey: { name: "buyerUserId", type: dynamodb.AttributeType.STRING },
    });

    // ── Seller PaymentManager service role (assumed by AgentCore for the
    //    seller's payout manager — mirrors the buyer-side manager role) ──
    const sellerManagerRole = new iam.Role(this, "StorefrontSellerManagerRole", {
      roleName: "AgentCorePayments-StorefrontSellerManager",
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        new iam.ServicePrincipal("preprod.genesis-service.aws.internal"),
        new iam.ServicePrincipal("developer.genesis-service.aws.internal"),
      ),
    });
    sellerManagerRole.addToPolicy(new iam.PolicyStatement({
      // For production, replace "bedrock-agentcore:*" with the specific actions
      // this role needs. The wildcard is used here because the AgentCore
      // Payments APIs are in preview and the action set is still evolving; the
      // resource list below is already scoped to this account's default token
      // vault and workload-identity directory.
      effect: iam.Effect.ALLOW,
      actions: ["bedrock-agentcore:*", "bedrock-agentcore:GetWorkloadAccessToken"],
      resources: [
        `arn:aws:bedrock-agentcore:*:${this.account}:token-vault/default`,
        `arn:aws:bedrock-agentcore:*:${this.account}:token-vault/default/*`,
        `arn:aws:bedrock-agentcore:*:${this.account}:token-vault/default/paymentcredentialprovider/*`,
        `arn:aws:bedrock-agentcore:*:${this.account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:*:${this.account}:workload-identity-directory/default/workload-identity/*`,
      ],
    }));
    sellerManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW, actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:*:${this.account}:secret:*`],
    }));
    sellerManagerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW, actions: ["sts:SetContext"],
      resources: [`arn:aws:sts::${this.account}:self`],
    }));

    // ── Digital delivery buckets ──
    // Assets bucket: private store of the seller's deliverable files (seeded at
    // deploy). Order service presigns these on a confirmed digital "file" sale.
    const assetsBucket = new cdk.aws_s3.Bucket(this, "StorefrontAssetsBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });
    // Seed the deliverable files into the assets bucket at deploy time.
    new cdk.aws_s3_deployment.BucketDeployment(this, "StorefrontAssetsDeploy", {
      sources: [cdk.aws_s3_deployment.Source.asset(path.join(lambdasDir, "sellers", "storefront", "deliverables"))],
      destinationBucket: assetsBucket,
      destinationKeyPrefix: "deliverables",
    });
    // Library bucket is declared earlier (shared with the agent runtime) so
    // generated images and purchased files land in one per-buyer library.

    // ── Storefront lambda roles ──
    const storefrontEnv = {
      PRODUCTS_TABLE: productsTable.tableName,
      ORDERS_TABLE: ordersTable.tableName,
      SELLER_CONFIG_TABLE: sellerConfigTable.tableName,
      USDC_CONTRACT: process.env.USDC_CONTRACT || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      SOLANA_USDC_MINT: process.env.SOLANA_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
      ASSETS_BUCKET: assetsBucket.bucketName,
      LIBRARY_BUCKET: libraryBucket.bucketName,
      // SES sender for physical-order emails. Empty by default → the order
      // still completes and an emailPreview is returned (graceful fallback).
      STORE_FROM_EMAIL: process.env.STORE_FROM_EMAIL || "",
      // HMAC secret for license redeem tokens. No hardcoded default: sourced
      // from .env (blank by default). When blank, the lambda falls back to a
      // per-process random value (tokens are signed-only, never verified
      // server-side), so a forgeable well-known secret is never shipped.
      LICENSE_SIGNING_SECRET: process.env.LICENSE_SIGNING_SECRET || "",
      // Attribute seller-originated refunds in Payments observability.
      PAYMENTS_AGENT_NAME: process.env.PAYMENTS_AGENT_NAME || "agentcore-payments-agent",
    };
    const storefrontDir = path.join(lambdasDir, "sellers", "storefront");

    // Product service — public read, DB read only.
    const productFn = new lambda.Function(this, "ProductFn", {
      functionName: "x402-storefront-products",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(storefrontDir),
      handler: "products.handler",
      environment: storefrontEnv,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
    });
    productsTable.grantReadData(productFn);

    // Order service — x402 middleware + seller-originated refunds.
    const orderRole = new iam.Role(this, "OrderServiceRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    orderRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:CreatePaymentSession",
        "bedrock-agentcore:GetPaymentSession",
        "bedrock-agentcore:ProcessPayment",
        "bedrock-agentcore:GetPaymentInstrument",
      ],
      resources: ["*"],
    }));
    // Digital delivery: read deliverables from the assets bucket, write buyer
    // copies to the library bucket, and send physical-order confirmation email.
    orderRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [assetsBucket.arnForObjects("*")],
    }));
    orderRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      resources: [libraryBucket.arnForObjects("*")],
    }));
    orderRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ses:SendEmail", "ses:SendRawEmail"],
      // Scoped to SES identities in this account/region. The seller's payout
      // email is verified as an identity here (during Seller Setup), so the
      // order service can only send from identities owned by this deployment.
      resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
    }));
    const orderFn = new lambda.Function(this, "OrderFn", {
      functionName: "x402-storefront-orders",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(storefrontDir),
      handler: "orders.handler",
      role: orderRole,
      environment: storefrontEnv,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
    });
    productsTable.grantReadWriteData(orderFn);
    ordersTable.grantReadWriteData(orderFn);
    sellerConfigTable.grantReadData(orderFn);

    // Seller setup service — admin-triggered control-plane provisioning.
    const sellerSetupRole = new iam.Role(this, "SellerSetupRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    sellerSetupRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:CreatePaymentCredentialProvider",
        "bedrock-agentcore:GetPaymentCredentialProvider",
        "bedrock-agentcore:ListPaymentCredentialProviders",
        "bedrock-agentcore:UpdatePaymentCredentialProvider",
        "bedrock-agentcore:DeletePaymentCredentialProvider",
        "bedrock-agentcore:CreatePaymentManager",
        "bedrock-agentcore:GetPaymentManager",
        "bedrock-agentcore:ListPaymentManagers",
        "bedrock-agentcore:CreatePaymentConnector",
        "bedrock-agentcore:GetPaymentConnector",
        "bedrock-agentcore:ListPaymentConnectors",
        "bedrock-agentcore:CreatePaymentInstrument",
        "bedrock-agentcore:GetPaymentInstrument",
        "bedrock-agentcore:ListPaymentInstruments",
        // Creating a credential provider implicitly provisions a token vault
        // and workload identity — mirror the buyer-side AdminCP role grants.
        "bedrock-agentcore:CreateTokenVault",
        "bedrock-agentcore:GetTokenVault",
        "bedrock-agentcore:ListTokenVaults",
        "bedrock-agentcore:DeleteTokenVault",
        "bedrock-agentcore:GetWorkloadAccessToken",
      ],
      resources: ["*"],
    }));
    sellerSetupRole.addToPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue"],
      // Scoped to secrets in this account/region (AgentCore Identity generates
      // the credential-provider secret names with random suffixes).
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`],
    }));
    // Verify the seller's payout email as an SES sender identity so order and
    // refund confirmations can be sent from it. Verification is a click the
    // seller completes once; until then, emails fall back to a returned preview.
    sellerSetupRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ses:VerifyEmailIdentity", "ses:GetIdentityVerificationAttributes"],
      resources: ["*"],
    }));
    sellerSetupRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"], resources: [sellerManagerRole.roleArn],
    }));
    const sellerSetupFn = new lambda.Function(this, "SellerSetupFn", {
      functionName: "x402-storefront-seller-setup",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(storefrontDir),
      handler: "seller-setup.handler",
      role: sellerSetupRole,
      environment: { ...storefrontEnv, SELLER_MANAGER_ROLE_ARN: sellerManagerRole.roleArn },
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
    });
    sellerConfigTable.grantReadWriteData(sellerSetupFn);

    // Library service — AUTHENTICATED (Cognito). Lists the caller's digital
    // purchases + saved media from the library bucket with presigned URLs.
    // Wired to the MAIN api (httpApi) with the Cognito authorizer because it
    // returns private, per-user content (scoped to the caller's sub).
    const libraryRole = new iam.Role(this, "LibraryServiceRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    libraryRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [libraryBucket.bucketArn],
    }));
    libraryRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [libraryBucket.arnForObjects("*")],
    }));
    const libraryFn = new lambda.Function(this, "LibraryFn", {
      functionName: "x402-storefront-library",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(storefrontDir),
      handler: "library.handler",
      role: libraryRole,
      environment: storefrontEnv,
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
    });
    // The library is order-backed: it queries the buyer's orders (via the
    // buyerUserId GSI) to list purchased digital goods. Needs read on the
    // orders table + its indexes.
    ordersTable.grantReadData(libraryFn);
    const libraryInt = new apigwv2int.HttpLambdaIntegration("LibraryInt", libraryFn);
    httpApi.addRoutes({ path: "/user/library", methods: [apigwv2.HttpMethod.GET], integration: libraryInt, authorizer });
    httpApi.addRoutes({ path: "/user/orders", methods: [apigwv2.HttpMethod.GET], integration: libraryInt, authorizer });

    // ── Storefront API Gateway (no Cognito — x402 proof is the auth) ──
    const storeApi = new apigwv2.HttpApi(this, "StorefrontApi", {
      apiName: "x402-storefront-api",
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["Content-Type", "X-Payment", "Payment-Signature", "Authorization"],
      },
    });
    const productInt = new apigwv2int.HttpLambdaIntegration("ProductInt", productFn);
    storeApi.addRoutes({ path: "/products", methods: [apigwv2.HttpMethod.GET], integration: productInt });
    storeApi.addRoutes({ path: "/products/{id}", methods: [apigwv2.HttpMethod.GET], integration: productInt });
    const orderInt = new apigwv2int.HttpLambdaIntegration("OrderInt", orderFn);
    // Public storefront routes (no Cognito — the agent has no token; the x402
    // proof authorizes a buy, and order id is the capability for read/refund).
    // NOTE: listing all orders, seller config/setup, and FORCE refunds are NOT
    // here — they are admin-only and mounted on the main Cognito API below.
    storeApi.addRoutes({ path: "/orders", methods: [apigwv2.HttpMethod.POST], integration: orderInt });
    // Buyer-scoped order list (GET /orders?userId=...): lets the agent look up
    // its own past orders (to find an order id to refund) across sessions. The
    // handler returns only the caller's orders and refund-relevant fields.
    storeApi.addRoutes({ path: "/orders", methods: [apigwv2.HttpMethod.GET], integration: orderInt });
    storeApi.addRoutes({ path: "/orders/{id}", methods: [apigwv2.HttpMethod.GET], integration: orderInt });
    storeApi.addRoutes({ path: "/orders/{id}/refund", methods: [apigwv2.HttpMethod.POST], integration: orderInt });
    storeApi.addRoutes({ path: "/orders/{id}/update", methods: [apigwv2.HttpMethod.POST], integration: orderInt });
    storeApi.addRoutes({ path: "/orders/{id}/download", methods: [apigwv2.HttpMethod.GET], integration: orderInt });

    // Admin-only storefront endpoints on the MAIN Cognito API, behind the JWT
    // authorizer + an in-lambda require_admin (ID-token + admin group). The
    // path prefix /admin/storefront also flips on FORCE-refund capability.
    // NOTE: a single HttpLambdaIntegration can only bind to one API, so these
    // use their own integration instances (distinct from the storefront ones)
    // even though they target the same lambdas.
    const adminSellerInt = new apigwv2int.HttpLambdaIntegration("AdminSellerInt", sellerSetupFn);
    const adminOrderInt = new apigwv2int.HttpLambdaIntegration("AdminOrderInt", orderFn);
    httpApi.addRoutes({ path: "/admin/storefront/seller/config", methods: [apigwv2.HttpMethod.GET], integration: adminSellerInt, authorizer });
    httpApi.addRoutes({ path: "/admin/storefront/seller/setup", methods: [apigwv2.HttpMethod.POST], integration: adminSellerInt, authorizer });
    httpApi.addRoutes({ path: "/admin/storefront/orders", methods: [apigwv2.HttpMethod.GET], integration: adminOrderInt, authorizer });
    httpApi.addRoutes({ path: "/admin/storefront/orders/{id}/refund", methods: [apigwv2.HttpMethod.POST], integration: adminOrderInt, authorizer });

    // ── Product seed (custom resource: loads seed-products.json into DDB) ──
    const seedFn = new lambda.Function(this, "ProductSeedFn", {
      functionName: "x402-storefront-seed",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(storefrontDir),
      handler: "seed.handler",
      environment: storefrontEnv,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
    });
    productsTable.grantReadWriteData(seedFn);
    const seedProvider = new cdk.custom_resources.Provider(this, "ProductSeedProvider", {
      onEventHandler: seedFn,
    });
    new cdk.CustomResource(this, "ProductSeed", {
      serviceToken: seedProvider.serviceToken,
      properties: { version: "4" }, // bump to re-seed
    });

    // ── Storefront static site (S3 + CloudFront, no auth) ──
    const storefrontBucket = new cdk.aws_s3.Bucket(this, "StorefrontBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });
    const storefrontDistribution = new cdk.aws_cloudfront.Distribution(this, "StorefrontDistribution", {
      comment: "Agent-economy storefront (static catalog)",
      defaultBehavior: {
        origin: cdk.aws_cloudfront_origins.S3BucketOrigin.withOriginAccessControl(storefrontBucket),
        viewerProtocolPolicy: cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cdk.aws_cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
    });
    // Deploy the storefront site assets (catalog HTML/CSS/JS + product images)
    // AND inject config.js (the storefront API URL) in a SINGLE deployment.
    // Using two separate BucketDeployments on the same bucket conflicts: the
    // asset deploy prunes everything not in its own source, which deletes the
    // config.js written by the other deploy. Merging the sources avoids that.
    new cdk.aws_s3_deployment.BucketDeployment(this, "StorefrontDeploy", {
      sources: [
        cdk.aws_s3_deployment.Source.asset(path.join(storefrontDir, "site")),
        cdk.aws_s3_deployment.Source.data(
          "config.js",
          `window.STOREFRONT_API_URL = "${storeApi.apiEndpoint}";`,
        ),
      ],
      destinationBucket: storefrontBucket,
      distribution: storefrontDistribution,
      distributionPaths: ["/*"],
    });

    // ── Outputs ──
    new cdk.CfnOutput(this, "StorefrontApiUrl", { value: storeApi.apiEndpoint });
    new cdk.CfnOutput(this, "StorefrontUrl", { value: `https://${storefrontDistribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "StorefrontAssetsBucketName", { value: assetsBucket.bucketName });
    new cdk.CfnOutput(this, "StorefrontLibraryBucketName", { value: libraryBucket.bucketName });
    new cdk.CfnOutput(this, "SellerManagerRoleArn", { value: sellerManagerRole.roleArn });
    new cdk.CfnOutput(this, "SellerApiUrl", { value: sellerApi.apiEndpoint });
    new cdk.CfnOutput(this, "MediaBucketName", { value: mediaBucket.bucketName });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "AdminCredentialsSecretName", { value: adminCredentialsSecret.secretName });
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "PaymentManagerRoleArn", { value: paymentManagerRole.roleArn });
    new cdk.CfnOutput(this, "AgentEcrRepoUri", { value: agentRepo.repositoryUri });
    new cdk.CfnOutput(this, "AgentRuntimeArn", { value: agentRuntime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, "AgentRuntimeId", { value: agentRuntime.attrAgentRuntimeId });
    // Endpoint is constructed from the runtime ID — actual invocation URL is:
    // https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{runtimeId}/invocations
    new cdk.CfnOutput(this, "AgentRuntimeEndpoint", {
      value: `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${agentRuntime.attrAgentRuntimeId}/invocations`,
    });
    new cdk.CfnOutput(this, "AgentMemoryId", { value: agentMemory.attrMemoryId });
    new cdk.CfnOutput(this, "AgentExecutionRoleArn", { value: agentExecutionRole.roleArn });

    // ══════════════════════════════════════════════════════════════════
    // cdk-nag (AwsSolutionsChecks) suppressions
    // Each entry documents an intentional design decision for this
    // open-source sample. Findings that were genuine improvements are fixed
    // in the resource definitions above (S3 enforceSSL, DynamoDB PITR, and
    // CloudFront origin access control), not suppressed here.
    // ══════════════════════════════════════════════════════════════════
    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "Lambda execution roles use the AWS managed AWSLambdaBasicExecutionRole, " +
          "which only grants CloudWatch Logs write access (the minimal logging " +
          "permission every function needs). All business permissions are added as " +
          "scoped inline policies.",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      },
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Wildcards are scoped to the narrowest form each API allows: " +
          "(1) Amazon Bedrock AgentCore payments control/data-plane actions are not " +
          "resource-scopeable in preview, so they are constrained by action set " +
          "against account-level token-vault, workload-identity, payment-manager, " +
          "and memory ARNs; (2) Bedrock model access uses the 'us.' cross-region " +
          "inference profile, so foundation-model and inference-profile are " +
          "wildcarded across regions; (3) CloudWatch vended log-delivery " +
          "Describe*/Put*Delivery* APIs do not support resource scoping; " +
          "(4) object-level wildcards (bucket/*, index/*) and action wildcards " +
          "(s3:GetObject*, s3:Abort*, etc.) are emitted by CDK grant() helpers for " +
          "least-privilege access to one specific bucket or table.",
      },
      {
        id: "AwsSolutions-APIG4",
        reason:
          "The seller and storefront HTTP APIs intentionally omit a Cognito/JWT " +
          "authorizer: the x402 payment proof (HTTP 402 to ProcessPayment to retry) " +
          "is the authorization, and product/order reads are capability-scoped by " +
          "order id. Admin and per-user content endpoints DO sit behind the Cognito " +
          "JWT authorizer on the main API. CORS preflight (OPTIONS) routes are " +
          "unauthenticated by design.",
      },
      {
        id: "AwsSolutions-APIG1",
        reason:
          "Access logging is omitted on the HTTP APIs to keep the sample lean; " +
          "request tracing is available through AgentCore observability and X-Ray. " +
          "Enable stage access logs before production use.",
      },
      {
        id: "AwsSolutions-S1",
        reason:
          "S3 server access logging is omitted: these buckets are ephemeral demo " +
          "stores (RemovalPolicy.DESTROY with autoDeleteObjects; media expires in " +
          "1 day), so a dedicated log bucket is unnecessary for the sample.",
      },
      {
        id: "AwsSolutions-L1",
        reason:
          "Remaining non-latest runtimes belong to CDK-managed custom-resource " +
          "framework Lambdas (BucketDeployment, Provider framework, log retention, " +
          "auto-delete-objects) whose runtime is selected by aws-cdk-lib. The " +
          "stack's own functions use the latest Node.js 22 and Python 3.13 runtimes.",
      },
      {
        id: "AwsSolutions-CB4",
        reason:
          "The CodeBuild project only builds and pushes the agent container image; " +
          "its artifacts use default AWS-managed encryption. A customer-managed KMS " +
          "key is unnecessary for this transient build pipeline in the sample.",
      },
      {
        id: "AwsSolutions-COG1",
        reason:
          "The user pool enforces an 8+ character policy with uppercase and digits. " +
          "Symbols are intentionally not required so the single generated demo admin " +
          "password (Secrets Manager, punctuation excluded to avoid shell-escaping " +
          "in the setup script) satisfies the policy. Strengthen for production.",
      },
      {
        id: "AwsSolutions-COG2",
        reason:
          "MFA is not required on the demo user pool to keep the sample sign-up " +
          "flow frictionless. Enable MFA before production use.",
      },
      {
        id: "AwsSolutions-COG3",
        reason:
          "AdvancedSecurityMode (deprecated) / Plus feature plan is a paid tier not " +
          "required for this sample. Enable it for production deployments.",
      },
      {
        id: "AwsSolutions-COG8",
        reason:
          "The Cognito Plus feature plan (advanced security) is a paid tier not " +
          "required for this sample. Enable it for production deployments.",
      },
      {
        id: "AwsSolutions-SMG4",
        reason:
          "The demo admin secret is generated once and intentionally kept stable " +
          "across redeploys so the documented retrieval flow works; automatic " +
          "rotation would invalidate the seeded Cognito admin login. Rotate or " +
          "replace this account before production.",
      },
      {
        id: "AwsSolutions-CFR1",
        reason:
          "The storefront CloudFront distribution serves a public static catalog " +
          "with no geographic restriction by design.",
      },
      {
        id: "AwsSolutions-CFR2",
        reason:
          "AWS WAF is not attached to the demo storefront distribution. WAF " +
          "integration (including AI traffic monetization) is on the roadmap.",
      },
      {
        id: "AwsSolutions-CFR3",
        reason:
          "CloudFront access logging is omitted for the demo storefront to keep " +
          "the sample lean. Enable it before production use.",
      },
      {
        id: "AwsSolutions-CFR4",
        reason:
          "The distribution uses the default *.cloudfront.net viewer certificate, " +
          "which pins the minimum TLS protocol to TLSv1 regardless of the requested " +
          "minimum. A custom domain with an ACM certificate is required to raise it " +
          "and is out of scope for the sample.",
      },
    ]);
  }
}
