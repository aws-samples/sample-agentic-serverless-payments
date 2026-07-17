import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { StatusBadge } from '@/components/ui/StatusBadge'
import * as api from '@/lib/api'
import { Store, ExternalLink, CheckCircle2, KeyRound, Copy, Check } from 'lucide-react'

const STOREFRONT_URL = (import.meta.env.VITE_STOREFRONT_URL as string) || ''

export function SellerSetup() {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [apiKeyId, setApiKeyId] = useState('')
  const [apiKeySecret, setApiKeySecret] = useState('')
  const [walletSecret, setWalletSecret] = useState('')
  const [walletEmail, setWalletEmail] = useState('')

  const refresh = async () => {
    setLoading(true)
    try {
      const r = await api.getSellerConfig()
      setConfig(r.config && r.config.status !== 'NOT_CONFIGURED' ? r.config : null)
    } catch {
      setConfig(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const handleSetup = async () => {
    if (!apiKeyId || !apiKeySecret || !walletEmail) {
      setError('API Key ID, API Key Secret, and a real wallet email are required')
      return
    }
    setSubmitting(true); setError('')
    try {
      const r = await api.setupSeller({ apiKeyId, apiKeySecret, walletSecret, walletEmail })
      setConfig(r.config)
      setApiKeyId(''); setApiKeySecret(''); setWalletSecret('')
    } catch (e: any) {
      setError(e.message || 'Seller setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
          <Store size={18} /> Seller Setup
        </h1>
        <p className="text-xs text-text-muted mt-0.5">
          Provision the storefront's payout wallets so the agent economy can collect payments and issue refunds.
        </p>
      </div>

      {/* Storefront link */}
      {STOREFRONT_URL && (
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-text-primary">Storefront</p>
              <p className="text-xs text-text-muted mt-0.5">The public catalog agents buy from.</p>
            </div>
            <a href={STOREFRONT_URL} target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1.5 rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20">
              Open Storefront <ExternalLink size={13} />
            </a>
          </div>
        </Card>
      )}

      {loading ? (
        <Card><p className="text-sm text-text-muted">Loading seller config…</p></Card>
      ) : config ? (
        <ConfiguredView config={config} onRefresh={refresh} />
      ) : (
        <Card>
          <div className="flex items-start gap-3 mb-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10">
              <KeyRound size={16} className="text-accent" />
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">Connect a Coinbase CDP payout wallet</p>
              <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                Creates the seller's payment manager, connector, and two payout wallets (Base Sepolia + Solana).
                The wallet email must be a real inbox — it receives the Coinbase Wallet Hub delegation link so the
                seller can sign refunds. (It does not need to match your admin login email.)
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">CDP API Key ID</label>
              <Input value={apiKeyId} onChange={(e) => setApiKeyId(e.target.value)} placeholder="e.g. organizations/.../apiKeys/..." />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">CDP API Key Secret</label>
              <Input type="password" value={apiKeySecret} onChange={(e) => setApiKeySecret(e.target.value)} placeholder="-----BEGIN EC PRIVATE KEY-----" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">CDP Wallet Secret (optional)</label>
              <Input type="password" value={walletSecret} onChange={(e) => setWalletSecret(e.target.value)} placeholder="Wallet secret for delegated signing" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Payout Wallet Email (real inbox)</label>
              <Input type="email" value={walletEmail} onChange={(e) => setWalletEmail(e.target.value)} placeholder="seller@example.com" />
            </div>
          </div>

          {error && <p className="text-xs text-danger mt-3">{error}</p>}

          <div className="mt-5 flex justify-end">
            <Button onClick={handleSetup} disabled={submitting}>
              {submitting ? 'Provisioning…' : 'Provision Seller Wallets'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}

function ConfiguredView({ config, onRefresh }: { config: any; onRefresh: () => void }) {
  const [copied, setCopied] = useState(false)
  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-success" />
            <p className="text-sm font-semibold text-text-primary">Seller provisioned</p>
          </div>
          <StatusBadge status={config.status} />
        </div>
        <div className="space-y-2 rounded-lg bg-surface-2 p-3">
          {[
            ['Manager ARN', config.managerArn],
            ['Connector ID', config.connectorId],
            ['Wallet Email', config.walletEmail],
            ['EVM Payout (Base Sepolia)', config.evmPayToAddress],
            ['Solana Payout (Devnet)', config.solPayToAddress],
          ].map(([label, value]) => (
            <div key={label as string} className="flex flex-col gap-0.5">
              <span className="text-[11px] font-semibold text-text-secondary">{label}</span>
              <span className="text-[11px] font-mono text-text-muted break-all">{value || '—'}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Delegation — required before refunds can be signed */}
      {(config.evmDelegationUrl || config.solDelegationUrl) && (
        <Card className="border-amber-500/20 bg-amber-500/5">
          <p className="text-sm font-semibold text-amber-400 mb-1">Complete wallet delegation (one-time)</p>
          <p className="text-xs text-text-muted leading-relaxed mb-3">
            Open each link, verify with the OTP sent to {config.walletEmail}, and grant signing permission.
            Until this is done, the seller can receive payments but cannot sign refunds.
          </p>
          <div className="flex gap-2 flex-wrap">
            {config.evmDelegationUrl && (
              <a href={config.evmDelegationUrl} target="_blank" rel="noopener noreferrer"
                 className="flex items-center gap-1.5 rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/25">
                Delegate EVM Wallet <ExternalLink size={13} />
              </a>
            )}
            {config.solDelegationUrl && (
              <a href={config.solDelegationUrl} target="_blank" rel="noopener noreferrer"
                 className="flex items-center gap-1.5 rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/25">
                Delegate Solana Wallet <ExternalLink size={13} />
              </a>
            )}
          </div>
        </Card>
      )}

      {/* Solana funding — one-time, makes the Solana payout wallet receive-ready */}
      {config.solPayToAddress && (
        <Card className="border-sky-500/20 bg-sky-500/5">
          <p className="text-sm font-semibold text-sky-400 mb-1">Fund the Solana payout wallet (one-time)</p>
          <p className="text-xs text-text-muted leading-relaxed mb-3">
            Send a small amount of testnet USDC to the Solana payout address once. A new Solana wallet has no
            USDC token account yet, and an SPL token can only land in an account that already exists. Funding it
            once creates that account, after which Solana purchases settle cleanly. Until then, Solana orders fail
            at the facilitator. EVM needs no such step.
          </p>
          <div className="flex flex-col gap-0.5 mb-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-text-secondary">Solana Payout (Devnet)</span>
              <Button variant="ghost" size="sm" onClick={() => copyAddress(config.solPayToAddress)}>
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </Button>
            </div>
            <span className="text-[11px] font-mono text-text-muted break-all">{config.solPayToAddress}</span>
          </div>
          <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-500/25">
            Open Circle USDC Faucet <ExternalLink size={13} />
          </a>
        </Card>
      )}

      {/* SES sender verification — needed for order + refund confirmation emails */}
      {config.walletEmail && (
        <Card className="border-violet-500/20 bg-violet-500/5">
          <p className="text-sm font-semibold text-violet-300 mb-1">Verify the payout email for notifications (one-time)</p>
          <p className="text-xs text-text-muted leading-relaxed">
            Order and refund confirmations are sent from {config.walletEmail}. During setup, Amazon SES emailed
            that address a verification link; open it once so emails can send. In the SES sandbox, recipient
            addresses must also be verified, or request SES production access to email any buyer. Until verified,
            orders and refunds still complete and a preview is returned instead of an email.
          </p>
        </Card>
      )}

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={onRefresh}>Refresh</Button>
      </div>
    </>
  )
}
