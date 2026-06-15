/**
 * Native AWS WAF x402 monetization config for the AI-content seller WebACL.
 *
 * NOTE: AWS WAF AI traffic monetization is GA, but `MonetizationConfig` + the per-rule
 * `Monetize` action are not yet in the released CloudFormation/CDK schema (SDK/CFN
 * support is expected to follow shortly). These pure builders produce the declarative
 * shape; the stack applies them to the L1 CfnWebACL via addPropertyOverride so they
 * pass through CloudFormation verbatim — the supported way to set them until the typed
 * props land.
 *
 * Pricing maps the repo's dynamic estimator (nova-llm per-token, nova-canvas
 * per-image; estimator.js) onto fixed WAF tiers: base $0.002 USDC × per-route
 * multiplier (text ×1 ≈ $0.002, image ×20 ≈ $0.04). Base Sepolia USDC.
 */

export const BOT_NAMESPACE = 'awswaf:managed:aws:bot-control:bot:';
export const BOT_CONTROL_VERSION = 'Version_6.0';
export const BASE_AMOUNT = '0.002';

export interface Tier {
  name: string;
  /** CloudFront-style URI prefix (STARTS_WITH). */
  prefix: string;
  multiplier: number;
}

export const TIERS: Tier[] = [
  { name: 'text', prefix: '/generate-text', multiplier: 1 },
  { name: 'image', prefix: '/generate-image', multiplier: 20 },
];

interface VisibilityConfig {
  SampledRequestsEnabled: boolean;
  CloudWatchMetricsEnabled: boolean;
  MetricName: string;
}

export interface WebAclRule {
  Name: string;
  Priority: number;
  Statement: Record<string, unknown>;
  Action?: Record<string, unknown>;
  OverrideAction?: Record<string, unknown>;
  VisibilityConfig: VisibilityConfig;
}

function vis(metricName: string): VisibilityConfig {
  return { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: metricName };
}

function pathMatch(prefix: string): Record<string, unknown> {
  return {
    ByteMatchStatement: {
      SearchString: Buffer.from(prefix).toString('base64'),
      FieldToMatch: { UriPath: {} },
      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
      PositionalConstraint: 'STARTS_WITH',
    },
  };
}

function botNamespaceMatch(): Record<string, unknown> {
  return { LabelMatchStatement: { Scope: 'NAMESPACE', Key: BOT_NAMESPACE } };
}

export function buildMonetizationConfig(walletAddress: string): Record<string, unknown> {
  return {
    CryptoConfig: {
      PaymentNetworks: [
        {
          Chain: 'BASE_SEPOLIA',
          WalletAddress: walletAddress,
          Prices: [{ Amount: BASE_AMOUNT, Currency: 'USDC' }],
        },
      ],
    },
    CurrencyMode: 'TEST',
  };
}

export function buildWebAclRules(metricPrefix: string): WebAclRule[] {
  const rules: WebAclRule[] = [
    {
      Name: 'AWSBotControl',
      Priority: 0,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: 'AWS',
          Name: 'AWSManagedRulesBotControlRuleSet',
          Version: BOT_CONTROL_VERSION,
          ManagedRuleGroupConfigs: [
            { AWSManagedRulesBotControlRuleSet: { InspectionLevel: 'COMMON' } },
          ],
        },
      },
      OverrideAction: { Count: {} },
      VisibilityConfig: vis(`${metricPrefix}-bot-control`),
    },
    {
      Name: 'human-allow',
      Priority: 1,
      Statement: { NotStatement: { Statement: botNamespaceMatch() } },
      Action: { Allow: {} },
      VisibilityConfig: vis(`${metricPrefix}-human-allow`),
    },
    {
      Name: 'allow-discovery',
      Priority: 2,
      Statement: {
        OrStatement: {
          Statements: [pathMatch('/health'), pathMatch('/estimate'), pathMatch('/.well-known/')],
        },
      },
      Action: { Allow: {} },
      VisibilityConfig: vis(`${metricPrefix}-allow-discovery`),
    },
  ];

  TIERS.forEach((tier, i) => {
    rules.push({
      Name: `Monetize-${tier.name}`,
      Priority: 10 + i,
      Statement: pathMatch(tier.prefix),
      Action: { Monetize: { PriceMultiplier: String(tier.multiplier) } },
      VisibilityConfig: vis(`${metricPrefix}-monetize-${tier.name}`),
    });
  });

  return rules;
}
