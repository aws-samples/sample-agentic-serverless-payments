import {
  BASE_AMOUNT,
  TIERS,
  buildMonetizationConfig,
  buildWebAclRules,
} from '../lib/waf-monetization';

describe('serverless WAF monetization', () => {
  it('models nova-llm (text) at ×1 and nova-canvas (image) at ×20 off a 0.002 base', () => {
    expect(BASE_AMOUNT).toBe('0.002');
    expect(TIERS.find((t) => t.name === 'text')?.multiplier).toBe(1);
    expect(TIERS.find((t) => t.name === 'image')?.multiplier).toBe(20);
  });

  it('builds a Base Sepolia USDC MonetizationConfig with the seller wallet', () => {
    const cfg = buildMonetizationConfig('0xseller') as any;
    expect(cfg.CryptoConfig.PaymentNetworks[0].Chain).toBe('BASE_SEPOLIA');
    expect(cfg.CryptoConfig.PaymentNetworks[0].WalletAddress).toBe('0xseller');
    expect(cfg.CryptoConfig.PaymentNetworks[0].Prices[0]).toEqual({ Amount: '0.002', Currency: 'USDC' });
    expect(cfg.CurrencyMode).toBe('TEST');
  });

  it('rules: bot-control, human-allow, free /health + /estimate + /.well-known, then a Monetize per tier', () => {
    const rules = buildWebAclRules('ai-content');
    const names = rules.map((r) => r.Name);
    expect(names[0]).toBe('AWSBotControl');
    expect(names).toContain('human-allow');
    expect(names).toContain('allow-discovery');
    expect(names.filter((n) => n.startsWith('Monetize-'))).toHaveLength(TIERS.length);
    const prios = rules.map((r) => r.Priority);
    expect([...prios].sort((a, b) => a - b)).toEqual(prios);
  });
});
