import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUserStore, useAdminStore } from '@/store'
import { useAuthStore } from '@/store/auth'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { VendorBadge } from '@/components/ui/VendorBadge'
import {
  formatDate,
  getWalletDetails,
  getConnectorVendor,
  getInstrumentVendor,
  vendorLabel,
  vendorSubLabel,
} from '@/lib/utils'
import { getUsdcBalance, resolveInstrumentContext } from '@/lib/balance'
import * as api from '@/lib/api'
import { Wallet, Plus, Eye, RefreshCw, Copy, Check, ExternalLink, ShieldCheck, Trash2 } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { PaymentInstrument, Vendor } from '@/types'

export function Instruments() {
  const navigate = useNavigate()
  const { instruments, addInstrument, setInstruments, removeInstrument } = useUserStore()
  const { paymentManagers, paymentConnectors } = useAdminStore()
  const { email: userEmail } = useAuthStore()

  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<PaymentInstrument | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [balances, setBalances] = useState<{ usdc: string } | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)

  // Delete-instrument confirm dialog state. AgentCore performs a soft
  // delete — the instrument stays in the service's audit log but is
  // excluded from normal listings and no longer usable for payments.
  const [deleting, setDeleting] = useState<PaymentInstrument | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)


  // Form state — vendor picker drives which connectors are selectable
  const [vendor, setVendor] = useState<Vendor>('CoinbaseCDP')
  const [selectedConnector, setSelectedConnector] = useState('')
  const [network, setNetwork] = useState('ETHEREUM')

  // Filter connectors by the selected vendor
  const vendorConnectors = useMemo(
    () => paymentConnectors.filter((c) => getConnectorVendor(c) === vendor),
    [paymentConnectors, vendor],
  )

  // Normalize service-shape items into the frontend PaymentInstrument type.
  const normalize = (items: any[]): PaymentInstrument[] =>
    items.map((r) => ({ ...r }))

  const refresh = async () => {
    setLoading(true); setError('')
    try {
      const managerArns = paymentManagers.map((m) => m.paymentManagerArn).filter(Boolean)
      // ListPaymentInstruments returns IDs + status fast, but NOT the wallet
      // address (that lives only on GetPaymentInstrument). List first for an
      // immediate render, then enrich each row with a parallel Get so the
      // address/details populate.
      const data = await api.listAllInstruments(managerArns)
      const listed = normalize(data.paymentInstruments || [])
      listed.sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tb - ta
      })
      setInstruments(listed)

      // Enrich with wallet details (address, redirectUrl) via GetPaymentInstrument.
      const enriched = await Promise.all(
        listed.map(async (inst) => {
          const ctx = resolveInstrumentContext(inst, paymentConnectors, paymentManagers)
          if (!ctx.managerArn || !ctx.connectorId) return inst
          try {
            const full = await api.getInstrument(inst.paymentInstrumentId, {
              managerArn: ctx.managerArn,
              connectorId: ctx.connectorId,
            })
            return { ...inst, ...(full.paymentInstrument || {}) }
          } catch {
            return inst
          }
        }),
      )
      setInstruments(normalize(enriched))
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const { _prefetched } = useUserStore()

  useEffect(() => { if (!_prefetched) refresh() }, [])

  // Fetch USDC balance for the selected instrument via GetPaymentInstrumentBalance.
  // Extracted into a callback so the detail dialog's Refresh button can re-run
  // it on demand (on-chain balance lags after funding from a faucet).
  const loadBalance = useCallback((inst: PaymentInstrument | null) => {
    if (!inst) { setBalances(null); return }
    const { walletAddress } = getWalletDetails(inst)
    if (!walletAddress) { setBalances(null); return }
    const ctx = resolveInstrumentContext(inst, paymentConnectors, paymentManagers)
    if (!ctx.managerArn || !ctx.connectorId) { setBalances(null); return }
    setBalanceLoading(true)
    getUsdcBalance(inst, ctx)
      .then((usdc) => setBalances({ usdc }))
      .catch(() => setBalances(null))
      .finally(() => setBalanceLoading(false))
  }, [paymentConnectors, paymentManagers])

  useEffect(() => { loadBalance(viewing) }, [viewing, loadBalance])

  const handleCreate = async () => {
    setLoading(true); setError('')
    try {
      const conn = paymentConnectors.find((c) => c.paymentConnectorId === selectedConnector)
      const manager = paymentManagers.find((m) => m.paymentManagerId === conn?.paymentManagerId)
      if (!manager || !conn) { setError('Select a valid connector'); setLoading(false); return }
      if (!userEmail) { setError('No email on session — cannot create embedded wallet'); setLoading(false); return }

      // Under the new Wallet Hub flow the service provisions the Coinbase
      // wallet server-side against its own CDP end-user and returns the
      // authoritative UUID on the response. No in-app CDP email OTP
      // needed at create time; the user completes email verification on
      // the hub page via the `redirectUrl`.
      const data = await api.createInstrument({
        paymentManagerArn: manager.paymentManagerArn,
        paymentConnectorId: conn.paymentConnectorId,
        network,
        email: userEmail,
      })
      const instrument = data.paymentInstrument || data
      addInstrument(instrument)
      setCreating(false)
      setSelectedConnector(''); setNetwork('ETHEREUM')

      // Coinbase wallets come back with a Wallet Hub `redirectUrl`. Open it
      // in a new tab so the user can verify their email and grant signing
      // delegation immediately — the hub replaces the legacy in-app CDP OTP
      // + Grant Delegation flow. Privy instruments return no `redirectUrl`,
      // so this only fires for Coinbase.
      const hubUrl = getWalletDetails(instrument).redirectUrl
      if (hubUrl) {
        window.open(hubUrl, '_blank', 'noopener')
      }
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // ── Delete instrument ───────────────────────────────────────────────────
  // AgentCore does a soft delete server-side; the row drops from the table.

  const handleDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true); setError('')
    try {
      const ctx = resolveInstrumentContext(deleting, paymentConnectors, paymentManagers)
      await api.deleteInstrument(deleting.paymentInstrumentId, {
        managerArn: ctx.managerArn,
        connectorId: ctx.connectorId,
      })
      removeInstrument(deleting.paymentInstrumentId)
      setDeleting(null)
    } catch (err: any) {
      setError(err?.message || 'Failed to delete instrument')
    } finally {
      setDeleteBusy(false)
    }
  }

  const columns = [
    { key: 'id', header: 'Instrument ID', render: (r: PaymentInstrument) => <span className="text-xs font-mono">{r.paymentInstrumentId}</span> },
    { key: 'vendor', header: 'Vendor', render: (r: PaymentInstrument) => <VendorBadge vendor={getInstrumentVendor(r, paymentConnectors)} /> },
    { key: 'network', header: 'Network', render: (r: PaymentInstrument) => {
      const net = getWalletDetails(r).network
      if (!net) return <span className="text-xs text-text-muted">—</span>
      return <span className="rounded bg-surface-3 px-2 py-0.5 text-xs font-mono">{net}</span>
    }},
    { key: 'wallet', header: 'Wallet Address', render: (r: PaymentInstrument) => {
      const { walletAddress } = getWalletDetails(r)
      if (!walletAddress) return <span className="text-xs text-text-muted">Pending…</span>
      return <span className="text-xs font-mono text-text-muted">{walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}</span>
    }},
    { key: 'status', header: 'Status', render: (r: PaymentInstrument) => <StatusBadge status={r.status} /> },
    { key: 'actions', header: '', className: 'w-48', render: (r: PaymentInstrument) => {
      const vend = getInstrumentVendor(r, paymentConnectors)
      const isPrivy = vend === 'StripePrivy'
      const isCoinbase = vend === 'CoinbaseCDP'
      const redirectUrl = getWalletDetails(r).redirectUrl
      return (
        <div className="flex items-center justify-end gap-1">
          {isCoinbase && redirectUrl && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Open in Coinbase"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation()
                window.open(redirectUrl, '_blank', 'noopener')
              }}
              title="Opens the Coinbase Wallet Hub where you verify your email and authorize the agent to sign payments."
              icon={<ExternalLink size={12} />}
            >
              <span className="text-[11px]">Open in Coinbase</span>
            </Button>
          )}
          {isPrivy && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Connect agent"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation()
                navigate('/user/connect-agent')
              }}
              title="Authorize the agent to sign payments from your Privy wallets."
              icon={<ShieldCheck size={12} />}
            >
              <span className="text-[11px]">Connect Agent</span>
            </Button>
          )}
          <Button variant="ghost" size="sm" aria-label="View details" onClick={(e: React.MouseEvent) => { e.stopPropagation(); setViewing(r) }}><Eye size={14} /></Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Delete instrument"
            title="Delete instrument"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); setDeleting(r) }}
          >
            <Trash2 size={14} className="text-danger" />
          </Button>
        </div>
      )
    }},
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">My Instruments</h1>
          <p className="text-xs text-text-muted mt-0.5">Embedded crypto wallets provisioned for payments</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading} icon={<RefreshCw size={14} />}>Refresh</Button>
          <Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Wallet</Button>
        </div>
      </div>

      {error && <div className="rounded-lg bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>}

      <Card className="p-0 overflow-hidden">
        <DataTable columns={columns} data={instruments} keyExtractor={(r) => r.paymentInstrumentId} onRowClick={setViewing}
          emptyState={<EmptyState icon={<Wallet size={24} />} title="No instruments" description="Create an embedded crypto wallet to start making payments."
            action={<Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Wallet</Button>} />} />
      </Card>

      {/* Create dialog — vendor picker → connector list filters → network */}
      <Dialog.Root open={creating} onOpenChange={setCreating}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <Dialog.Title className="text-base font-semibold text-text-primary">Create Embedded Wallet</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">
              {vendor === 'CoinbaseCDP'
                ? <>A Coinbase-managed wallet linked to <span className="font-mono">{userEmail || 'your account'}</span>. AgentCore handles signing on your behalf via the credential provider.</>
                : <>A Privy-managed wallet linked to <span className="font-mono">{userEmail || 'your account'}</span>. AgentCore handles signing automatically.</>}
            </Dialog.Description>

            {/* Vendor picker */}
            <div className="mt-5 space-y-1.5">
              <label className="block text-xs font-medium text-text-secondary">Vendor</label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Vendor">
                {(['CoinbaseCDP', 'StripePrivy'] as Vendor[]).map((v) => {
                  const selected = vendor === v
                  return (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => { setVendor(v); setSelectedConnector('') }}
                      className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? 'border-accent bg-accent/10 ring-1 ring-accent/40'
                          : 'border-border bg-surface-2 hover:border-border/80'
                      }`}
                    >
                      <VendorBadge vendor={v} />
                      <span className="text-[10px] text-text-muted">{vendorSubLabel(v)}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-text-secondary">Connector</label>
                <select className="flex h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                  value={selectedConnector} onChange={(e) => setSelectedConnector(e.target.value)}>
                  <option value="">Select a {vendorLabel(vendor)} connector…</option>
                  {vendorConnectors.map((c) => (
                    <option key={c.paymentConnectorId} value={c.paymentConnectorId}>
                      {c.name} ({c.paymentManagerId})
                    </option>
                  ))}
                </select>
                {vendorConnectors.length === 0 && (
                  <p className="text-[10px] text-text-muted">
                    No {vendorLabel(vendor)} connectors available. Admin must create one first.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-text-secondary">Network</label>
                <select className="flex h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                  value={network} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNetwork(e.target.value)}>
                  <option value="ETHEREUM">ETHEREUM</option>
                  <option value="SOLANA">SOLANA</option>
                </select>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setCreating(false); setSelectedConnector(''); setNetwork('ETHEREUM') }}>Cancel</Button>
              <Button size="sm" onClick={() => handleCreate()} disabled={!selectedConnector || loading}>{loading ? 'Creating…' : 'Create'}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!viewing} onOpenChange={() => setViewing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl" aria-describedby="view-instrument-desc">
            <Dialog.Title className="text-base font-semibold text-text-primary">Instrument Details</Dialog.Title>
            <Dialog.Description id="view-instrument-desc" className="sr-only">Details of the selected payment instrument</Dialog.Description>
            {viewing && (() => {
              const details = getWalletDetails(viewing)
              const instVendor = getInstrumentVendor(viewing, paymentConnectors)
              return (
                <div className="mt-4 space-y-3 text-sm">
                  {/* Vendor header */}
                  <div className="flex items-center gap-2">
                    <VendorBadge vendor={instVendor} />
                    <span className="text-[10px] text-text-muted">{vendorSubLabel(instVendor)}</span>
                  </div>
                  {([['Instrument ID', viewing.paymentInstrumentId], ['Type', viewing.paymentInstrumentType],
                    ['Network', details.network],
                    // Linked Email only shows when the service returns one;
                    // omit the row entirely rather than render a blank dash.
                    ...(details.email ? [['Linked Email', details.email]] as [string, string | undefined][] : []),
                    ['Connector ID', viewing.paymentConnectorId], ['Status', viewing.status],
                    ['Created', viewing.createdAt ? formatDate(viewing.createdAt) : undefined],
                  ] as [string, string | undefined][]).map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4">
                      <span className="text-text-muted shrink-0">{label}</span>
                      <span className="text-text-primary font-mono text-xs text-right break-all">{value || '—'}</span>
                    </div>
                  ))}
                  {details.walletAddress && (
                    <div className="mt-2 rounded-lg bg-surface-2 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-text-muted">Wallet Address</span>
                        <Button variant="ghost" size="sm" onClick={() => copyAddress(details.walletAddress!)}>
                          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                        </Button>
                      </div>
                      <p className="text-xs font-mono text-accent break-all">{details.walletAddress}</p>
                    </div>
                  )}
                  {/* Signing status — vendor aware */}
                  <div className="mt-2 rounded-lg bg-surface-2 p-3">
                    <p className="text-xs font-semibold text-text-secondary mb-1">Signing</p>
                    {instVendor === 'CoinbaseCDP' ? (
                      details.redirectUrl ? (
                        <div className="space-y-2">
                          <p className="text-xs text-text-muted">
                            Open this wallet's Coinbase Wallet Hub to verify your email and authorize the agent to sign x402 payments.
                          </p>
                          <a
                            href={details.redirectUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-3 px-3 py-1.5 text-xs font-medium text-accent hover:bg-surface-2 transition-colors"
                          >
                            <ExternalLink size={12} />
                            Open Coinbase Wallet Hub
                          </a>
                        </div>
                      ) : (
                        <p className="text-xs text-text-muted">
                          Open the Coinbase Wallet Hub for this wallet to verify your email and authorize the agent to sign x402 payments.
                        </p>
                      )
                    ) : instVendor === 'StripePrivy' ? (
                      <div className="space-y-2">
                        <p className="text-xs text-text-muted">
                          Use <span className="font-semibold text-text-primary">Connect Agent</span> to attach the agent's authorization-key quorum to your Privy wallet. Once attached, the agent can sign x402 payments against it indefinitely.
                        </p>
                        <button
                          type="button"
                          onClick={() => navigate('/user/connect-agent')}
                          className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-3 px-3 py-1.5 text-xs font-medium text-accent hover:bg-surface-2 transition-colors"
                        >
                          <ShieldCheck size={12} />
                          Connect Agent
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-text-muted">Vendor not recognized — unable to show signing status.</p>
                    )}
                  </div>
                  {/* Instrument USDC balance (via GetPaymentInstrumentBalance) */}
                  {details.walletAddress && (
                    <div className="mt-2 rounded-lg bg-surface-2 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-text-secondary">Instrument Balance</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Refresh balance"
                          title="Refresh balance"
                          disabled={balanceLoading}
                          onClick={() => loadBalance(viewing)}
                        >
                          <RefreshCw size={12} className={balanceLoading ? 'animate-spin' : ''} />
                        </Button>
                      </div>
                      {balanceLoading ? (
                        <div className="flex items-center gap-2 py-1">
                          <div className="h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent" />
                          <span className="text-xs text-text-muted">Fetching balance…</span>
                        </div>
                      ) : balances ? (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-muted">USDC</span>
                          <span className="text-sm font-semibold tabular-nums text-text-primary">{balances.usdc} USDC</span>
                        </div>
                      ) : (
                        <span className="text-xs text-text-muted">Unable to fetch balance</span>
                      )}
                    </div>
                  )}
                  {/* Top Up Wallet links */}
                  <div className="mt-3 flex gap-2">
                    <a
                      href="https://faucet.circle.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs font-medium text-accent hover:bg-surface-3 transition-colors"
                    >
                      <ExternalLink size={12} />
                      USDC Faucet
                    </a>
                    <a
                      href={details.network === 'SOLANA' ? 'https://faucet.solana.com/' : 'https://www.alchemy.com/faucets/base-sepolia'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs font-medium text-accent hover:bg-surface-3 transition-colors"
                    >
                      <ExternalLink size={12} />
                      {details.network === 'SOLANA' ? 'SOL Faucet' : 'ETH Faucet'}
                    </a>
                  </div>
                </div>
              )
            })()}
            <div className="mt-6 flex justify-end"><Button variant="secondary" size="sm" onClick={() => setViewing(null)}>Close</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Delete-instrument confirm. Soft delete service-side — the record
          stays in AgentCore's audit log but the instrument won't appear in
          listings and can't sign payments. Funds on-chain are unaffected. */}
      <Dialog.Root open={!!deleting} onOpenChange={(o) => { if (!o && !deleteBusy) setDeleting(null) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Delete instrument?</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">
              This instrument won't appear in your wallet list anymore and the agent can't sign payments against it. Any USDC in the wallet stays on-chain and is recoverable with the wallet's private key — it's not lost.
            </Dialog.Description>
            {deleting && (() => {
              const { walletAddress, network } = getWalletDetails(deleting)
              return (
                <div className="mt-4 rounded-lg bg-surface-2 p-3 text-xs space-y-1.5">
                  <div className="flex justify-between gap-4">
                    <span className="text-text-muted">Instrument ID</span>
                    <span className="font-mono text-right break-all">{deleting.paymentInstrumentId}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-text-muted">Network</span>
                    <span className="font-mono">{network}</span>
                  </div>
                  {walletAddress && (
                    <div className="flex justify-between gap-4">
                      <span className="text-text-muted">Wallet</span>
                      <span className="font-mono text-right break-all">{walletAddress.slice(0, 8)}…{walletAddress.slice(-6)}</span>
                    </div>
                  )}
                </div>
              )
            })()}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDeleting(null)} disabled={deleteBusy}>Cancel</Button>
              <Button size="sm" onClick={handleDelete} disabled={deleteBusy}>
                {deleteBusy ? 'Deleting…' : 'Delete instrument'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
