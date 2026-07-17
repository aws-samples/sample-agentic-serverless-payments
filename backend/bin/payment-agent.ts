#!/usr/bin/env node
// dotenv loaded via -r dotenv/config in cdk.json (DOTENV_CONFIG_PATH=../.env)
import * as cdk from "aws-cdk-lib/core";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { PaymentAgentStack } from "../lib/payment-agent-stack";

const app = new cdk.App();
new PaymentAgentStack(app, "PaymentAgentStack", {
  env: {
    account: process.env.AWS_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION || "us-east-1",
  },
});

// cdk-nag AWS Solutions checks. Set CDK_NAG=0 to skip (e.g. fast local
// iteration); CI and the documented deploy run with checks enabled.
if (process.env.CDK_NAG !== "0") {
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}
