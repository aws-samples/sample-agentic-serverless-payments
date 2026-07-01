import { Card } from '@/components/ui/Card'
import {
  KeyRound, CreditCard, Link2, Shield, Zap, Workflow,
  Lock, ArrowDownRight, Server, Globe,
} from 'lucide-react'

const SETUP_STEPS = [
  {
    icon: KeyRound,
    color: '#6366f1',
    number: '1',
    title: 'CreatePaymentCredentialProvider',
    subtitle: 'Control Plane · bedrock-agentcore-control',
    description: 'Registers a credential provider in the AgentCore payments Token Vault for one of two vendors: Coinbase CDP (API key ID, API key secret, wallet secret) or Stripe/Privy (Privy app credentials). Secrets are stored in AWS Secrets Manager so AgentCore payments can sign on behalf of users without exposing private keys to the agent.',
    details: [
      { label: 'Input', value: 'Coinbase CDP keys, or Stripe/Privy app credentials' },
      { label: 'Storage', value: 'AWS Secrets Manager (via Token Vault)' },
      { label: 'Output', value: 'Credential Provider ARN' },
    ],
  },
  {
    icon: CreditCard,
    color: '#22c55e',
    number: '2',
    title: 'CreatePaymentManager',
    subtitle: 'Control Plane · bedrock-agentcore-control',
    description: 'Creates a payment manager linked to the credential provider. The manager is configured with an IAM service role that AgentCore payments assumes to access the Token Vault and sign payments. This role is provisioned automatically by the CDK stack.',
    details: [
      { label: 'Input', value: 'Manager name, IAM Role ARN (auto-provisioned)' },
      { label: 'Links to', value: 'Credential Provider (from step 1)' },
      { label: 'Output', value: 'Payment Manager ID + ARN' },
    ],
  },
  {
    icon: Link2,
    color: '#f59e0b',
    number: '3',
    title: 'CreatePaymentConnector',
    subtitle: 'Control Plane · bedrock-agentcore-control',
    description: 'Binds a payment manager to a credential provider. The connector type matches the provider vendor (CoinbaseCDP or StripePrivy). Seller URLs are not stored on the connector; the agent holds the seller endpoints, and AgentCore payments routes ProcessPayment using the manager and connector when the agent encounters a 402.',
    details: [
      { label: 'Input', value: 'Connector name, Manager ID, Provider ARN' },
      { label: 'Links to', value: 'Payment Manager + Credential Provider' },
      { label: 'Output', value: 'Payment Connector ID' },
    ],
  },
]

const ARCHITECTURE = [
  {
    icon: Lock,
    title: 'Token Vault',
    description: 'Wallet private keys are stored in AWS Secrets Manager via the Token Vault. The agent never has access to keys; AgentCore payments retrieves them at signing time through the credential provider.',
  },
  {
    icon: Shield,
    title: 'IAM Service Role',
    description: 'The payment manager assumes an IAM service role to access the Token Vault. The role is scoped to specific Secrets Manager resources and workload identity operations.',
  },
  {
    icon: Workflow,
    title: 'Session Context',
    description: 'Payment context (manager ARN, instrument, session, network, and vendor user ID) is threaded from the frontend to the agent through the WebSocket init frame and REST body. The AgentCorePaymentsPlugin routes ProcessPayment on each 402, so no separate datastore is required.',
  },
  {
    icon: Server,
    title: 'AgentCore Runtime',
    description: 'The payment agent runs as a container image on Amazon Bedrock AgentCore Runtime, built by AWS CodeBuild and stored in Amazon ECR. It uses the Strands Agents framework for orchestration and the AgentCorePaymentsPlugin as the canonical x402 payer.',
  },
]

const DATA_PLANE_APIS = [
  {
    name: 'CreatePaymentInstrument',
    description: 'Registers a user wallet (ETHEREUM or SOLANA). Credentials stored securely in the Token Vault.',
  },
  {
    name: 'CreatePaymentSession',
    description: 'Starts a spending session with a USDC spending limit (15 to 480 min expiry). Caps what the agent can spend.',
  },
  {
    name: 'GetPaymentInstrumentBalance',
    description: 'Reads the wallet USDC balance on Base Sepolia or Solana Devnet. Powers the free check_balance tool.',
  },
  {
    name: 'ProcessPayment',
    description: 'Signs EIP-3009 (EVM) or SPL transfer (Solana) proofs. Driven by the AgentCorePaymentsPlugin on each 402.',
  },
]

const SELLER_CAPABILITIES = [
  {
    name: 'Storefront orders',
    description: 'A catalog plus x402 orders that verify the proof, reserve inventory, settle, then fulfil a digital file, a license token, or a physical-order email.',
  },
  {
    name: 'Image generation',
    description: 'An x402-gated Amazon Nova Canvas seller. The agent stores the image in Amazon S3 and shares a short-lived link plus a durable library copy.',
  },
  {
    name: 'Refunds (seller as payer)',
    description: 'A consume-gated agent refund and an admin force-refund, each through a per-refund spend-capped session that pays the buyer back.',
  },
]

function StepCard({ step }: { step: typeof SETUP_STEPS[0] }) {
  const Icon = step.icon
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: step.color + '18' }}>
          <Icon size={20} style={{ color: step.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold" style={{ background: step.color + '18', color: step.color }}>
              {step.number}
            </span>
            <h3 className="text-sm font-semibold text-text-primary font-mono">{step.title}</h3>
          </div>
          <p className="text-[10px] text-text-muted mt-0.5 font-mono">{step.subtitle}</p>
        </div>
      </div>
      <p className="text-xs text-text-muted leading-relaxed mb-3">{step.description}</p>
      <div className="space-y-1.5 rounded-lg bg-surface-2 p-3">
        {step.details.map(d => (
          <div key={d.label} className="flex items-start gap-2">
            <ArrowDownRight size={12} className="text-text-muted mt-0.5 shrink-0" />
            <div>
              <span className="text-[11px] font-semibold text-text-secondary">{d.label}: </span>
              <span className="text-[11px] text-text-muted">{d.value}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

export function AdminHowItWorks() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-text-primary">How It Works</h1>
        <p className="text-xs text-text-muted mt-0.5">Admin setup flow for Amazon Bedrock AgentCore payments infrastructure</p>
      </div>

      {/* Hero */}
      <Card className="bg-gradient-to-r from-indigo-500/10 via-surface-1 to-green-500/10 border-accent/20">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15">
            <Zap size={24} className="text-accent" />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">Amazon Bedrock AgentCore payments control plane</p>
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed max-w-xl">
              The admin flow configures the payment infrastructure before any user can transact. Three control-plane calls set up credential storage, payment management, and the manager-to-provider binding. Once configured, users create wallets and sessions through the data plane.
            </p>
          </div>
        </div>
      </Card>

      {/* Architecture diagrams */}
      <div className="grid grid-cols-1 gap-4">
        <Card>
          <p className="text-xs font-semibold text-text-primary mb-2">Buyer architecture</p>
          <img
            src="/agentcore-payments.png"
            alt="Amazon Bedrock AgentCore payments buyer architecture"
            className="w-full rounded-lg"
          />
          <p className="text-[11px] text-text-muted mt-2 leading-relaxed">
            Admin configures the control plane (credential provider, manager, connector). The user creates a wallet instrument and a spend-capped session, then chats with the agent over a WebSocket. On an HTTP 402 the AgentCorePaymentsPlugin runs ProcessPayment and settles through the x402 facilitator on Base Sepolia or Solana Devnet.
          </p>
        </Card>
        <Card>
          <p className="text-xs font-semibold text-text-primary mb-2">Seller architecture</p>
          <img
            src="/agentcore-payments-sellers.png"
            alt="Amazon Bedrock AgentCore payments seller architecture"
            className="w-full rounded-lg"
          />
          <p className="text-[11px] text-text-muted mt-2 leading-relaxed">
            Seller Setup provisions one AgentCore payments payout wallet shared by the image generator and the storefront. The storefront serves the catalog and x402 orders (verify, reserve inventory, settle, fulfil) and originates refunds as the payer through a per-refund capped session.
          </p>
        </Card>
      </div>

      {/* Setup steps */}
      <div>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Setup Flow (Control Plane)</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {SETUP_STEPS.map(step => <StepCard key={step.title} step={step} />)}
        </div>
      </div>

      {/* Architecture */}
      <div>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Infrastructure</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {ARCHITECTURE.map(item => (
            <Card key={item.title} className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                <item.icon size={16} className="text-accent" />
              </div>
              <div className="min-w-0">
                <span className="text-xs font-semibold text-text-primary">{item.title}</span>
                <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{item.description}</p>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Data Plane APIs */}
      <div>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Data Plane APIs (User-facing)</h2>
        <Card>
          <div className="space-y-3">
            {DATA_PLANE_APIS.map(api => (
              <div key={api.name} className="flex items-start gap-3">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-accent/10 mt-0.5">
                  <Globe size={12} className="text-accent" />
                </div>
                <div>
                  <span className="text-xs font-semibold text-text-primary font-mono">{api.name}</span>
                  <p className="text-[11px] text-text-muted leading-relaxed">{api.description}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Seller side */}
      <div>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Seller Side</h2>
        <Card>
          <div className="space-y-3">
            {SELLER_CAPABILITIES.map(item => (
              <div key={item.name} className="flex items-start gap-3">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-accent/10 mt-0.5">
                  <Globe size={12} className="text-accent" />
                </div>
                <div>
                  <span className="text-xs font-semibold text-text-primary">{item.name}</span>
                  <p className="text-[11px] text-text-muted leading-relaxed">{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Security note */}
      <Card className="border-border/50">
        <div className="flex items-start gap-3">
          <Lock size={16} className="text-text-muted mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-semibold text-text-secondary">Security Model</p>
            <p className="text-[11px] text-text-muted leading-relaxed">
              Wallet private keys never leave AWS Secrets Manager. The agent container has no access to keys; it calls ProcessPayment via boto3, and AgentCore payments retrieves credentials through the Token Vault using the IAM service role. Payment sessions enforce spending limits and time-limited expiry, giving users full control over agent spending.
            </p>
          </div>
        </div>
      </Card>
    </div>
  )
}
