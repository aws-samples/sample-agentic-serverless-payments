# Migration: in-app x402 middleware → Native CloudFront + WAF x402

## Why
AWS now monetizes AI traffic natively in CloudFront + WAF. The seller Lambdas no longer
need to verify/settle x402 payments via a facilitator.

## Scope
Both seller surfaces are migrated:
- `serverless/` — the AI-content HTTP API (`/generate` → split into `/generate-text` +
  `/generate-image` for tiered pricing; `/estimate`, `/health`).
- `agentic/` — the x402 payment gateway HTTP API (`/{proxy+}`).

## Before
`serverless/lambda/seller/seller.js` and `agentic/lambda/seller.js` ran an in-app x402
flow (402 challenge + `x402.org` facilitator verify/settle). Pricing was computed
dynamically per request (nova-llm per-token, nova-canvas per-image).

## After
- A CloudFront distribution fronts each HTTP API, with a CLOUDFRONT WAF WebACL:
  Bot Control v6 (detect), human-allow, free discovery (`/health`, `/estimate`,
  `/.well-known/*`), and per-tier Monetize rules.
- Dynamic pricing is mapped to fixed WAF tiers: base $0.002 USDC × multiplier —
  `/generate-text` ×1 (≈$0.002), `/generate-image` ×20 (≈$0.04). Base Sepolia USDC.
- The seller Lambdas now only produce content; the x402 verify/settle code is removed.

## IaC support status
AWS WAF AI traffic monetization is **GA** (configurable via the WAF console and API
today). Its `MonetizationConfig` + per-rule `Monetize` action are **not yet in the
released CloudFormation/CDK schema** — SDK/CFN support is expected to follow shortly.
They are applied via L1 `addPropertyOverride`, so the stacks synthesize the full WebACL
(including the monetization fields) and pass them through CloudFormation verbatim. The
override is the supported way to set these until the typed CDK/CFN properties land.

## Pricing-fidelity note
WAF fixed tiers cannot reproduce true per-token pricing. Text/image tiers are
representative; the per-token estimator (`/estimate`) remains free for agents to
price-check before paying.
