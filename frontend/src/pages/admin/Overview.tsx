import { useEffect, useState } from 'react'
import { KpiCard } from '@/components/ui/KpiCard'
import { Card, CardHeader, CardTitle } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { VendorBadge } from '@/components/ui/VendorBadge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useAdminStore } from '@/store'
import * as api from '@/lib/api'
import { getCredentialProviderVendor, vendorSubLabel } from '@/lib/utils'
import { KeyRound, CreditCard, Link2, Activity, Zap, Check, Loader2, AlertCircle } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import type { Vendor } from '@/types'

type SetupStep = 'idle' | 'running' | 'done' | 'error'

// The deployed frontend signer ID. The Connect Agent flow delegates user
// wallets to this authorization key, so a StripePrivy credential provider must
// be created with the SAME key (its Authorization Key ID must equal this) or
// the agent signs with a key the wallet never authorized and ProcessPayment
// fails. Used below to warn admins on a mismatch before Quick Setup runs.
const PRIVY_SIGNER_ID = import.meta.env.VITE_PRIVY_SIGNER_ID as string | undefined
const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined

const normalizeKeyId = (value: string) => value.trim().replace(/^wallet-auth:/, '')

function QuickSetup() {
  const {
    credentialProviders, paymentManagers, paymentConnectors,
    addCredentialProvider, addPaymentManager, addPaymentConnector,
  } = useAdminStore()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')

  // Vendor tab — which vendor we're creating the full stack for.
  const [vendor, setVendor] = useState<Vendor>('CoinbaseCDP')

  // Shared / Coinbase fields
  const [providerName, setProviderName] = useState('')
  const [apiKeyId, setApiKeyId] = useState('')
  const [apiKeySecret, setApiKeySecret] = useState('')
  const [walletSecret, setWalletSecret] = useState('')

  // Stripe / Privy fields
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [authorizationId, setAuthorizationId] = useState('')
  const [authorizationPrivateKey, setAuthorizationPrivateKey] = useState('')

  const [managerName, setManagerName] = useState('')
  const [connectorName, setConnectorName] = useState('')

  // Step status
  const [step1, setStep1] = useState<SetupStep>('idle')
  const [step2, setStep2] = useState<SetupStep>('idle')
  const [step3, setStep3] = useState<SetupStep>('idle')
  const [running, setRunning] = useState(false)

  const allExist = credentialProviders.length > 0 && paymentManagers.length > 0 && paymentConnectors.length > 0

  // Block when a StripePrivy provider's App ID or Authorization Key ID does not
  // match the deployed VITE_PRIVY_APP_ID / VITE_PRIVY_SIGNER_ID the Connect
  // Agent flow uses — either mismatch means ProcessPayment can never succeed.
  // Each check only fires when its frontend value is configured.
  const appIdMismatch =
    vendor === 'StripePrivy' &&
    !!PRIVY_APP_ID &&
    !!appId.trim() &&
    appId.trim() !== PRIVY_APP_ID.trim()
  const authIdMismatch =
    vendor === 'StripePrivy' &&
    !!PRIVY_SIGNER_ID &&
    !!authorizationId.trim() &&
    normalizeKeyId(authorizationId) !== normalizeKeyId(PRIVY_SIGNER_ID)
  const privyMismatch = appIdMismatch || authIdMismatch

  const handleSetup = async () => {
    setRunning(true); setError('')
    setStep1('running'); setStep2('idle'); setStep3('idle')

    try {
      // Step 1: Create Credential Provider (vendor-aware)
      const cpBody: any = { name: providerName, vendor }
      if (vendor === 'CoinbaseCDP') {
        cpBody.apiKeyId = apiKeyId
        cpBody.apiKeySecret = apiKeySecret
        cpBody.walletSecret = walletSecret
      } else {
        cpBody.appId = appId
        cpBody.appSecret = appSecret
        cpBody.authorizationId = authorizationId
        cpBody.authorizationPrivateKey = authorizationPrivateKey
      }
      const cpData = await api.createCredentialProvider(cpBody)
      addCredentialProvider(cpData)
      const cpArn = cpData.credentialProviderArn || cpData.credentialProvider?.credentialProviderArn
      setStep1('done')

      // Step 2: Create Payment Manager (vendor-agnostic)
      // Keep the description alphanumeric-only — the service validates it
      // against a tight regex and rejects parentheses etc.
      setStep2('running')
      const pmData = await api.createPaymentManager({
        name: managerName,
        description: `Created via Quick Setup for ${vendor === 'CoinbaseCDP' ? 'Coinbase' : 'Stripe'}`,
      })
      addPaymentManager(pmData)
      const pmId = pmData.paymentManagerId || pmData.paymentManager?.paymentManagerId
      setStep2('done')

      // Step 3: Create Payment Connector with matching vendor type
      setStep3('running')
      const pcData = await api.createPaymentConnector({
        paymentManagerId: pmId,
        name: connectorName,
        description: 'Created via Quick Setup',
        credentialProviderArn: cpArn,
        type: vendor,
      })
      addPaymentConnector({ ...pcData, paymentManagerId: pmId })
      setStep3('done')

      setTimeout(() => setOpen(false), 2000)
    } catch (err: any) {
      setError(err.message || 'Setup failed')
      if (step1 === 'running') setStep1('error')
      else if (step2 === 'running') setStep2('error')
      else setStep3('error')
    } finally {
      setRunning(false)
    }
  }

  const stepIcon = (s: SetupStep) => {
    if (s === 'running') return <Loader2 size={14} className="animate-spin text-accent" />
    if (s === 'done') return <Check size={14} className="text-success" />
    if (s === 'error') return <AlertCircle size={14} className="text-danger" />
    return <div className="h-3.5 w-3.5 rounded-full border border-border" />
  }

  const canSubmit = (() => {
    if (running) return false
    if (!providerName || !managerName || !connectorName) return false
    if (vendor === 'CoinbaseCDP') return !!(apiKeyId && apiKeySecret && walletSecret)
    // Block on an App ID or authorization-key mismatch — the agent could never
    // authenticate/sign against the Privy app + key the Connect Agent flow uses.
    if (privyMismatch) return false
    return !!(appId && appSecret && authorizationId && authorizationPrivateKey)
  })()

  return (
    <Card className="border-accent/30 bg-accent/5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10">
            <Zap size={18} className="text-accent" />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">Quick Setup</p>
            <p className="text-xs text-text-muted">{allExist ? 'Payment infrastructure is configured' : 'Create all payment infrastructure in one step'}</p>
          </div>
        </div>
        {!open && (
          <Button size="sm" variant={allExist ? 'secondary' : 'primary'} onClick={() => setOpen(true)} icon={<Zap size={14} />}>
            {allExist ? 'Setup Again' : 'Start Setup'}
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-5 space-y-5">
          {error && <div className="rounded-lg bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>}

          {/* Vendor picker */}
          <div className="space-y-1.5">
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
                    disabled={running}
                    onClick={() => setVendor(v)}
                    className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'border-accent bg-accent/10 ring-1 ring-accent/40'
                        : 'border-border bg-surface-2 hover:border-border/80 disabled:opacity-50'
                    }`}
                  >
                    <VendorBadge vendor={v} />
                    <span className="text-[10px] text-text-muted">{vendorSubLabel(v)}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Credential Provider fields */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {stepIcon(step1)}
              <span className="text-xs font-semibold text-text-secondary">1. Credential Provider</span>
            </div>
            {vendor === 'CoinbaseCDP' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pl-6">
                <Input label="Provider Name" value={providerName} onChange={(e) => setProviderName(e.target.value.replace(/[^a-zA-Z0-9\-_]/g, ''))} placeholder="my-cdp-provider" disabled={running} />
                <Input label="CDP API Key ID" value={apiKeyId} onChange={(e) => setApiKeyId(e.target.value)} placeholder="UUID from CDP Portal" disabled={running} />
                <Input label="CDP API Key Secret" type="password" value={apiKeySecret} onChange={(e) => setApiKeySecret(e.target.value)} placeholder="••••••••" disabled={running} />
                <Input label="CDP Wallet Secret" type="password" value={walletSecret} onChange={(e) => setWalletSecret(e.target.value)} placeholder="••••••••" disabled={running} />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pl-6">
                <Input label="Provider Name" value={providerName} onChange={(e) => setProviderName(e.target.value.replace(/[^a-zA-Z0-9\-_]/g, ''))} placeholder="my-stripe-provider" disabled={running} />
                <Input label="Privy App ID" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="App ID from Privy Dashboard" disabled={running} />
                {appIdMismatch && (
                  <p className="sm:col-span-2 rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning">
                    This App ID does not match the deployed <code className="font-mono">VITE_PRIVY_APP_ID</code>. The Connect Agent flow signs users into that Privy app, so the credential provider must use the same App ID or the agent operates against a different app than where the wallets live.
                  </p>
                )}
                <Input label="Privy App Secret" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="••••••••" disabled={running} />
                <Input label="Authorization Key ID" value={authorizationId} onChange={(e) => setAuthorizationId(e.target.value)} placeholder="P256 key ID from Privy Dashboard" disabled={running} />
                {authIdMismatch && (
                  <p className="sm:col-span-2 rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning">
                    This Authorization Key ID does not match the deployed <code className="font-mono">VITE_PRIVY_SIGNER_ID</code>. The Connect Agent flow delegates wallets to <code className="font-mono">VITE_PRIVY_SIGNER_ID</code>, so the agent can only sign if this credential provider uses the same authorization key.
                  </p>
                )}
                <Input label="Authorization Private Key" type="password" value={authorizationPrivateKey} onChange={(e) => setAuthorizationPrivateKey(e.target.value)} placeholder="••••••••" disabled={running} />
              </div>
            )}
          </div>

          {/* Payment Manager fields */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {stepIcon(step2)}
              <span className="text-xs font-semibold text-text-secondary">2. Payment Manager</span>
            </div>
            <div className="pl-6">
              <Input label="Manager Name" value={managerName} onChange={(e) => setManagerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} placeholder="MyPaymentManager" disabled={running} />
            </div>
          </div>

          {/* Payment Connector fields */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {stepIcon(step3)}
              <span className="text-xs font-semibold text-text-secondary">3. Payment Connector</span>
            </div>
            <div className="pl-6">
              <Input label="Connector Name" value={connectorName} onChange={(e) => setConnectorName(e.target.value.replace(/[^a-zA-Z0-9\-_]/g, ''))} placeholder="my-connector" disabled={running} />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={running}>Cancel</Button>
            <Button size="sm" onClick={handleSetup} disabled={!canSubmit} icon={running ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}>
              {running ? 'Setting up…' : 'Create All'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

export function AdminOverview() {
  const { credentialProviders, paymentManagers, paymentConnectors, setCredentialProviders, setPaymentManagers, setPaymentConnectors } = useAdminStore()
  const [loading, setLoading] = useState(true)
  const { _prefetched } = useAdminStore()

  useEffect(() => {
    if (_prefetched) { setLoading(false); return }

    let done = 0
    const check = () => { done++; if (done >= 2) setLoading(false) }

    api.listCredentialProviders()
      .then(d => setCredentialProviders(d.credentialProviders || []))
      .catch(() => {})
      .finally(check)

    api.listPaymentManagers()
      .then(d => {
        const managers = d.paymentManagers || []
        setPaymentManagers(managers)
        Promise.all(managers.map((m: any) =>
          api.listPaymentConnectors(m.paymentManagerId)
            // The connector list response doesn't echo paymentManagerId, so
            // stamp it on each row — delete/edit/get all need the full
            // manager ID (min length 12) to address the connector.
            .then(cd => (cd.paymentConnectors || []).map((c: any) => ({ ...c, paymentManagerId: m.paymentManagerId })))
            .catch(() => [] as any[])
        )).then(results => setPaymentConnectors(results.flat()))
      })
      .catch(() => {})
      .finally(check)
  }, [])

  const statusCounts = (items: { status?: string }[], defaultStatus = 'UNKNOWN') => {
    const counts: Record<string, number> = {}
    items.forEach((i) => {
      const s = i.status || defaultStatus
      counts[s] = (counts[s] || 0) + 1
    })
    return Object.entries(counts).map(([name, value]) => ({ name, value }))
  }

  // Vendor split across credential providers for an at-a-glance breakdown.
  const vendorCounts = (() => {
    const counts = { CoinbaseCDP: 0, StripePrivy: 0, Unknown: 0 }
    credentialProviders.forEach((cp) => {
      const v = getCredentialProviderVendor(cp)
      if (v === 'CoinbaseCDP') counts.CoinbaseCDP++
      else if (v === 'StripePrivy') counts.StripePrivy++
      else counts.Unknown++
    })
    return counts
  })()

  const chartData = [
    { name: 'Providers', count: credentialProviders.length, fill: '#6366f1' },
    { name: 'Managers', count: paymentManagers.length, fill: '#22c55e' },
    { name: 'Connectors', count: paymentConnectors.length, fill: '#f59e0b' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-text-primary">Admin Overview</h1>
        <p className="text-xs text-text-muted mt-0.5">Control plane resource status at a glance</p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Credential Providers"
          value={credentialProviders.length}
          icon={<KeyRound size={18} />}
          loading={loading}
        />
        <KpiCard
          label="Payment Managers"
          value={paymentManagers.length}
          icon={<CreditCard size={18} />}
          loading={loading}
        />
        <KpiCard
          label="Payment Connectors"
          value={paymentConnectors.length}
          icon={<Link2 size={18} />}
          loading={loading}
        />
        <KpiCard
          label="Total Resources"
          value={credentialProviders.length + paymentManagers.length + paymentConnectors.length}
          icon={<Activity size={18} />}
          loading={loading}
        />
      </div>

      {/* Vendor mix — quick signal of what's configured */}
      {credentialProviders.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Vendor Mix</CardTitle></CardHeader>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <VendorBadge vendor="CoinbaseCDP" />
              <span className="text-sm font-semibold tabular-nums text-text-primary">{vendorCounts.CoinbaseCDP}</span>
              <span className="text-xs text-text-muted">providers</span>
            </div>
            <div className="flex items-center gap-2">
              <VendorBadge vendor="StripePrivy" />
              <span className="text-sm font-semibold tabular-nums text-text-primary">{vendorCounts.StripePrivy}</span>
              <span className="text-xs text-text-muted">providers</span>
            </div>
            {vendorCounts.Unknown > 0 && (
              <div className="flex items-center gap-2">
                <VendorBadge vendor={null} />
                <span className="text-sm font-semibold tabular-nums text-text-primary">{vendorCounts.Unknown}</span>
                <span className="text-xs text-text-muted">providers</span>
              </div>
            )}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Resource Distribution Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Resource Distribution</CardTitle>
          </CardHeader>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} barSize={40}>
                <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  labelStyle={{ color: '#111827' }}
                  itemStyle={{ color: '#4b5563' }}
                />
                <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Recent Managers */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Payment Managers</CardTitle>
          </CardHeader>
          <div className="space-y-3">
            {paymentManagers.length === 0 ? (
              <p className="text-xs text-text-muted py-8 text-center">No managers yet</p>
            ) : (
              paymentManagers.slice(0, 5).map((m) => (
                <div key={m.paymentManagerId} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-text-primary">{m.name}</p>
                    <p className="text-xs text-text-muted font-mono">{m.paymentManagerId}</p>
                  </div>
                  <StatusBadge status={m.status} />
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Status Breakdown */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[
          { title: 'Provider Status', data: statusCounts(credentialProviders, 'ACTIVE') },
          { title: 'Manager Status', data: statusCounts(paymentManagers) },
          { title: 'Connector Status', data: statusCounts(paymentConnectors) },
        ].map(({ title, data }) => (
          <Card key={title}>
            <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
            {data.length === 0 ? (
              <p className="text-xs text-text-muted text-center py-4">No data</p>
            ) : (
              <div className="space-y-2">
                {data.map(({ name, value }) => (
                  <div key={name} className="flex items-center justify-between">
                    <StatusBadge status={name} />
                    <span className="text-sm font-semibold tabular-nums text-text-primary">{value}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* Quick Setup */}
      <QuickSetup />
    </div>
  )
}
