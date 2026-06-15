import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AiContentMonetizationStack } from '../lib/ai-content-monetization-stack';

describe('AiContentMonetizationStack (native WAF)', () => {
  const app = new cdk.App();
  const stack = new AiContentMonetizationStack(app, 'TestStack', {
    env: { region: 'us-east-1', account: '123456789012' },
  });
  const template = Template.fromStack(stack);

  it('creates a CLOUDFRONT WebACL with Bot Control v6', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSBotControl',
          Statement: Match.objectLike({
            ManagedRuleGroupStatement: Match.objectLike({ Version: 'Version_6.0' }),
          }),
        }),
      ]),
    });
  });

  it('injects MonetizationConfig via override', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      MonetizationConfig: Match.objectLike({ CurrencyMode: 'TEST' }),
    });
  });

  it('the distribution references the WebACL', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue() }),
    });
  });
});
