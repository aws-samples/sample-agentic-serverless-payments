#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { AiContentMonetizationStack } from '../lib/ai-content-monetization-stack';

const app = new cdk.App();
const stack = new AiContentMonetizationStack(app, 'AiContentMonetizationStack');

// Apply CDK Nag
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Stack-level suppressions for sample project
NagSuppressions.addStackSuppressions(stack, [
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole required for CloudWatch logging' },
  { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions required for dynamic Bedrock models, S3 objects, and WebSocket connections' },
  { id: 'AwsSolutions-L1', reason: 'Using Node.js 22 - latest LTS available in CDK' },
  { id: 'AwsSolutions-APIG1', reason: 'Access logging configured via CfnStage' },
  { id: 'AwsSolutions-APIG4', reason: 'Public API - authorization via x402 payment protocol' },
  { id: 'AwsSolutions-S1', reason: 'Ephemeral bucket with 1-day TTL' },
  { id: 'AwsSolutions-S10', reason: 'SSL enforced via bucket property' },
  { id: 'AwsSolutions-DDB3', reason: 'Ephemeral connection data with TTL' }
], true);