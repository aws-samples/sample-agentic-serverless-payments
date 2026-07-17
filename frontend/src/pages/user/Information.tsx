import { Card } from '@/components/ui/Card'
import {
  Image, ShoppingBag, Undo2,
  Shield, Zap, Layers, CreditCard,
} from 'lucide-react'

const STOREFRONT_URL = import.meta.env.VITE_STOREFRONT_URL || ''

const FLOWS = [
  {
    icon: ShoppingBag,
    color: '#22c55e',
    title: 'Agent Storefront Purchase',
    price: 'per product',
    description: 'An agent buys a product from the storefront, paying with x402',
    link: { label: 'View Storefront', path: '/' },
    steps: [
      { label: 'Agent', detail: 'Calls buy_product after browsing the catalog (list_products)' },
      { label: 'Order API', detail: 'Returns HTTP 402 with x402 payment requirements' },
      { label: 'ProcessPayment', detail: 'AgentCore Payments signs the payment proof from the session' },
      { label: 'Verify → Reserve → Settle', detail: 'Seller verifies, reserves inventory, then settles on-chain' },
      { label: 'Fulfillment', detail: 'Order CONFIRMED → confirmation + tracking returned to the agent' },
    ],
    networks: ['Base Sepolia', 'Solana Devnet'],
    sdk: 'x402 (HTTP 402) + AgentCore ProcessPayment',
  },
  {
    icon: Undo2,
    color: '#f59e0b',
    title: 'Cancel & Refund',
    price: 'reverse payment',
    description: 'A confirmed order is refunded by the seller, governed by a spend-capped session',
    steps: [
      { label: 'Trigger', detail: 'Agent calls cancel_order, or the admin clicks Refund' },
      { label: 'Refund Session', detail: 'Seller creates a PaymentSession capped at the refund amount' },
      { label: 'ProcessPayment', detail: 'Seller instrument signs a reverse proof → buyer address' },
      { label: 'Settle', detail: 'Seller settles the seller→buyer transfer on-chain' },
      { label: 'Order', detail: 'Marked REFUNDED, item restocked' },
    ],
    networks: ['Base Sepolia', 'Solana Devnet'],
    sdk: 'AgentCore ProcessPayment (seller as payer)',
  },
  {
    icon: Image,
    color: '#a78bfa',
    title: 'AI Image Generation',
    price: '$0.04 USDC',
    description: 'On-demand image creation via Amazon Nova Canvas',
    steps: [
      { label: 'Agent', detail: 'Calls generate_image tool with prompt' },
      { label: 'Seller API', detail: 'x402 middleware returns 402' },
      { label: 'ProcessPayment', detail: 'AgentCore Payments signs payment proof' },
      { label: 'Facilitator', detail: 'Verifies + settles USDC on-chain' },
      { label: 'Content', detail: 'Nova Canvas generates image → S3 presigned URL → delivered inline' },
    ],
    networks: ['Base Sepolia', 'Solana Devnet'],
    sdk: 'AgentCore ProcessPayment',
  },
]

const CORE_APIS = [
  {
    icon: CreditCard,
    name: 'ProcessPayment',
    plane: 'Data Plane',
    description: 'Signs EIP-3009 (EVM) or SPL token transfer (Solana) proofs. The agent never touches private keys — AgentCore Payments accesses wallet credentials through the Token Vault.',
  },
  {
    icon: Shield,
    name: 'CreatePaymentSession',
    plane: 'Data Plane',
    description: 'Authorizes agent spending with a USDC spending limit and time-limited expiry (15 to 480 min). The agent operates within these guardrails autonomously.',
  },
  {
    icon: Layers,
    name: 'CreatePaymentInstrument',
    plane: 'Data Plane',
    description: 'Registers user wallets (ETHEREUM or SOLANA). Credentials stored in Token Vault via the credential provider — never exposed to the agent.',
  },
  {
    icon: Zap,
    name: 'CreatePaymentConnector',
    plane: 'Control Plane',
    description: 'Binds a payment manager to a credential provider; the connector type matches the vendor. AgentCore payments uses it to route ProcessPayment to the right configuration on a 402.',
  },
]

function FlowCard({ flow }: { flow: typeof FLOWS[0] }) {
  const Icon = flow.icon
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: flow.color + '18' }}>
          <Icon size={20} style={{ color: flow.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text-primary">{flow.title}</h3>
            <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: flow.color + '18', color: flow.color }}>{flow.price}</span>
          </div>
          <p className="text-xs text-text-muted mt-0.5">{flow.description}</p>
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-0">
        {flow.steps.map((step, i) => (
          <div key={i} className="flex items-start gap-2.5 py-1.5">
            <div className="flex flex-col items-center mt-0.5">
              <div className="h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: flow.color + '18', color: flow.color }}>
                {i + 1}
              </div>
              {i < flow.steps.length - 1 && <div className="w-px h-4 mt-0.5" style={{ background: flow.color + '30' }} />}
            </div>
            <div className="min-w-0">
              <span className="text-[11px] font-semibold text-text-secondary">{step.label}</span>
              <p className="text-[11px] text-text-muted leading-tight">{step.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1.5">
          {flow.networks.map(n => (
            <span key={n} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-mono text-text-muted">{n}</span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {flow.link && STOREFRONT_URL && (
            <a
              href={`${STOREFRONT_URL}${flow.link.path}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/20 transition-colors"
            >
              {flow.link.label} ↗
            </a>
          )}
          <span className="text-[10px] text-text-muted">{flow.sdk}</span>
        </div>
      </div>
    </Card>
  )
}

export function Information() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-text-primary">How It Works</h1>
        <p className="text-xs text-text-muted mt-0.5">Payment patterns powered by Amazon Bedrock AgentCore payments</p>
      </div>

      {/* Hero banner */}
      <Card className="bg-gradient-to-r from-accent/10 via-surface-1 to-purple-500/10 border-accent/20">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15">
            <Zap size={24} className="text-accent" />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">Autonomous Agent Payments with AgentCore Payments</p>
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed max-w-xl">
              The agent discovers services, negotiates payment terms via HTTP 402, signs USDC transfers through AgentCore Payments' ProcessPayment API, and settles on-chain, all within a user-defined spending limit and session expiry. No private keys are ever exposed to the agent.
            </p>
          </div>
        </div>
      </Card>

      {/* Seller Architecture diagram */}
      <Card>
        <img
          src="/agentcore-payments-sellers.png"
          alt="Amazon Bedrock AgentCore payments seller patterns"
          className="w-full rounded-lg"
        />
      </Card>

      {/* Flow cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {FLOWS.map(flow => <FlowCard key={flow.title} flow={flow} />)}
      </div>

      {/* Trade-offs */}
      <div>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Pattern Trade-offs</h2>
        <Card className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-3 text-text-secondary font-semibold">Pattern</th>
                <th className="text-left py-2 pr-3 text-text-secondary font-semibold">Speed</th>
                <th className="text-left py-2 pr-3 text-text-secondary font-semibold">Settlement</th>
                <th className="text-left py-2 pr-3 text-text-secondary font-semibold">Best For</th>
                <th className="text-left py-2 text-text-secondary font-semibold">Trade-off</th>
              </tr>
            </thead>
            <tbody className="text-text-muted">
              <tr className="border-b border-border/50">
                <td className="py-2.5 pr-3 font-medium text-text-primary">Direct Seller (API)</td>
                <td className="py-2.5 pr-3"><span className="text-success">Fast</span> (~3-5s)</td>
                <td className="py-2.5 pr-3">x402 middleware (Hono)</td>
                <td className="py-2.5 pr-3">Machine-to-machine APIs, structured data, image generation</td>
                <td className="py-2.5">Requires seller to build an API with x402 middleware</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2.5 pr-3 font-medium text-text-primary">WAF AI traffic monetization (planned)</td>
                <td className="py-2.5 pr-3">Managed at the edge</td>
                <td className="py-2.5 pr-3">x402 facilitator (managed by AWS WAF)</td>
                <td className="py-2.5 pr-3">Charging AI agents for content or API access at the CloudFront edge with no application code</td>
                <td className="py-2.5">New capability; we will adopt it for the image generation seller once it is available through CDK</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-3 font-medium text-text-primary">Order API (stateful)</td>
                <td className="py-2.5 pr-3"><span className="text-success">Fast</span> (~5-8s)</td>
                <td className="py-2.5 pr-3">x402 middleware + DynamoDB (inventory/orders)</td>
                <td className="py-2.5 pr-3">Storefronts, commerce, anything with inventory + refunds</td>
                <td className="py-2.5">Stateful checkout: verify → reserve → settle, plus seller-originated refunds</td>
              </tr>
            </tbody>
          </table>
        </Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mt-3">
          <Card className="border-green-500/20 bg-green-500/5">
            <p className="text-[11px] font-semibold text-green-400 mb-1">Direct Seller, choose when:</p>
            <p className="text-[10px] text-text-muted leading-relaxed">You control the seller and want the fastest, most reliable payment flow. The seller exposes a clean API, and the x402 middleware handles everything.</p>
          </Card>
          <Card className="border-amber-500/20 bg-amber-500/5">
            <p className="text-[11px] font-semibold text-amber-400 mb-1">WAF monetization (planned):</p>
            <p className="text-[10px] text-text-muted leading-relaxed">
              <a href="https://aws.amazon.com/blogs/aws/aws-waf-adds-ai-traffic-monetization-capability-to-help-content-owners-charge-ai-bots-for-content-access/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">AWS WAF AI traffic monetization</a> charges AI agents for content at the CloudFront edge with no application code, returning HTTP 402 and settling through the x402 facilitator. We will adopt it for the image generation seller once it is available through CDK.
            </p>
          </Card>
          <Card className="border-cyan-500/20 bg-cyan-500/5">
            <p className="text-[11px] font-semibold text-cyan-400 mb-1">Order API, choose when:</p>
            <p className="text-[10px] text-text-muted leading-relaxed">You're running a storefront or commerce flow with inventory and refunds. The order Lambda enforces x402 payment, reserves stock, settles, and can issue seller-originated refunds — a complete money lifecycle.</p>
          </Card>
        </div>
      </div>

      {/* AgentCore APIs */}
      <div>
        <h2 className="text-sm font-semibold text-text-primary mb-3">AgentCore Payments APIs</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {CORE_APIS.map(api => (
            <Card key={api.name} className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                <api.icon size={16} className="text-accent" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-text-primary">{api.name}</span>
                  <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] font-mono text-text-muted">{api.plane}</span>
                </div>
                <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{api.description}</p>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
