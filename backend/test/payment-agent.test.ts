import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { PaymentAgentStack } from "../lib/payment-agent-stack";

// Smoke tests: assert the stack synthesizes and that the key resources +
// security properties this sample relies on are present in the template.
describe("PaymentAgentStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new PaymentAgentStack(app, "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("Cognito user pool allows self sign-up (AllowAdminCreateUserOnly=false)", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    });
  });

  test("provisions the three HTTP APIs (main, seller, storefront)", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 3);
  });

  test("provisions four DynamoDB tables with point-in-time recovery", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 4);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test("storefront idempotency table expires records by TTL", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "StorefrontIdempotency",
      KeySchema: [{ AttributeName: "idempotencyKey", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test("order function can use the idempotency table", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "x402-storefront-orders",
      Environment: { Variables: Match.objectLike({ IDEMPOTENCY_TABLE: Match.anyValue() }) },
    });
  });

  test("idempotency table access is limited to item reads and writes", () => {
    const [tableId] = Object.keys(template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: "StorefrontIdempotency" },
    }));
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => JSON.stringify(s.Resource).includes(tableId));
    expect(statements).toHaveLength(1);
    expect(statements[0].Effect).toBe("Allow");
    expect([...statements[0].Action].sort()).toEqual([
      "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
    ]);
  });

  test("creates the AgentCore runtime and memory", () => {
    template.resourceCountIs("AWS::BedrockAgentCore::Runtime", 1);
    template.resourceCountIs("AWS::BedrockAgentCore::Memory", 1);
  });

  test("seeds the demo admin credentials in Secrets Manager (generated, not hardcoded)", () => {
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "password",
      }),
    });
  });

  test("S3 buckets enforce SSL (deny non-TLS requests)", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:*",
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      }),
    });
  });
});
