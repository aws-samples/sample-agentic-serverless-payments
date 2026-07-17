// Data protection: this admin page creates and lists AgentCore payment
// credential providers (Coinbase CDP / Stripe-Privy connectors). It handles
// provider API-key references and wallet metadata, not payment card data, so
// PCI-DSS does not apply to this sample. Secret values are held in AWS Secrets
// Manager server-side and are never rendered here. Production deployments
// should apply access control and audit appropriate to their environment.
import { useState, useEffect } from 'react'
import { useAdminStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { VendorBadge } from '@/components/ui/VendorBadge'
import { truncateArn, getCredentialProviderVendor, vendorSubLabel } from '@/lib/utils'
import * as api from '@/lib/api'
import { KeyRound, Plus, Trash2, Eye, RefreshCw, Pencil } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { CredentialProvider, Vendor } from '@/types'

type VendorTab = Vendor

// The deployed frontend signer ID. The Connect Agent flow delegates user
// wallets to this authorization key, so a StripePrivy credential provider must
// be created with the SAME key (its Authorization Key ID must equal this) or
// the agent signs with a key the wallet never authorized and ProcessPayment
// fails. Used below to warn admins on a mismatch at create/rotate time.
const PRIVY_SIGNER_ID = import.meta.env.VITE_PRIVY_SIGNER_ID as string | undefined
const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined

const normalizeKeyId = (value: string) => value.trim().replace(/^wallet-auth:/, '')

export function CredentialProviders() {
  const { credentialProviders, addCredentialProvider, removeCredentialProvider, setCredentialProviders, updateCredentialProvider } = useAdminStore()
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<CredentialProvider | null>(null)
  const [editing, setEditing] = useState<CredentialProvider | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Shared form state
  const [vendor, setVendor] = useState<VendorTab>('CoinbaseCDP')
  const [name, setName] = useState('')

  // Coinbase fields
  const [apiKeyId, setApiKeyId] = useState('')
  const [apiKeySecret, setApiKeySecret] = useState('')
  const [walletSecret, setWalletSecret] = useState('')

  // Stripe / Privy fields
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [authorizationId, setAuthorizationId] = useState('')
  const [authorizationPrivateKey, setAuthorizationPrivateKey] = useState('')

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.listCredentialProviders()
      setCredentialProviders(data.credentialProviders || [])
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const { _prefetched } = useAdminStore()

  useEffect(() => { if (!_prefetched) refresh() }, [])

  const resetForm = () => {
    setVendor('CoinbaseCDP')
    setName('')
    setApiKeyId(''); setApiKeySecret(''); setWalletSecret('')
    setAppId(''); setAppSecret(''); setAuthorizationId(''); setAuthorizationPrivateKey('')
  }

  const handleCreate = async () => {
    setLoading(true)
    setError('')
    try {
      const body: any = { name, vendor }
      if (vendor === 'CoinbaseCDP') {
        body.apiKeyId = apiKeyId
        body.apiKeySecret = apiKeySecret
        body.walletSecret = walletSecret
      } else {
        body.appId = appId
        body.appSecret = appSecret
        body.authorizationId = authorizationId
        body.authorizationPrivateKey = authorizationPrivateKey
      }
      const data = await api.createCredentialProvider(body)
      addCredentialProvider(data)
      setCreating(false)
      resetForm()
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const handleDelete = async (providerName: string, providerVendor?: string) => {
    try {
      await api.deleteCredentialProvider(providerName, providerVendor)
      removeCredentialProvider(providerName)
    } catch (err: any) { setError(err.message) }
  }

  const openEdit = (p: CredentialProvider) => {
    const v = getCredentialProviderVendor(p) || 'CoinbaseCDP'
    setEditing(p)
    setVendor(v as VendorTab)
    setName(p.name)
    setApiKeyId(''); setApiKeySecret(''); setWalletSecret('')
    setAppId(''); setAppSecret(''); setAuthorizationId(''); setAuthorizationPrivateKey('')
  }

  const handleUpdate = async () => {
    if (!editing) return
    setLoading(true); setError('')
    try {
      const body: any = { vendor }
      if (vendor === 'CoinbaseCDP') {
        body.apiKeyId = apiKeyId
        body.apiKeySecret = apiKeySecret
        body.walletSecret = walletSecret
      } else {
        body.appId = appId
        body.appSecret = appSecret
        body.authorizationId = authorizationId
        body.authorizationPrivateKey = authorizationPrivateKey
      }
      const data = await api.updateCredentialProvider(editing.name, body)
      // Service returns the updated output config with new secret ARNs.
      updateCredentialProvider(editing.name, {
        providerConfigurationOutput: data.providerConfigurationOutput ?? editing.providerConfigurationOutput,
        lastUpdatedTime: data.lastUpdatedTime,
      } as any)
      setEditing(null)
      resetForm()
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  // Block when a StripePrivy provider's App ID or Authorization Key ID does not
  // match the deployed VITE_PRIVY_APP_ID / VITE_PRIVY_SIGNER_ID that the Connect
  // Agent flow uses. A mismatch means the agent authenticates against a
  // different Privy app, or signs with a key the wallet never authorized — so
  // ProcessPayment can never succeed. Each check only fires when its frontend
  // value is configured, so Coinbase / unconfigured deployments are unaffected.
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

  const canUpdate = (() => {
    if (!editing || loading) return false
    if (vendor === 'CoinbaseCDP') return !!(apiKeyId && apiKeySecret && walletSecret)
    if (privyMismatch) return false
    return !!(appId && appSecret && authorizationId && authorizationPrivateKey)
  })()

  // Validation for submit button per vendor
  const canSubmit = (() => {
    if (!name || loading) return false
    if (vendor === 'CoinbaseCDP') return !!(apiKeyId && apiKeySecret && walletSecret)
    if (privyMismatch) return false
    return !!(appId && appSecret && authorizationId && authorizationPrivateKey)
  })()

  const columns = [
    { key: 'name', header: 'Name', render: (r: CredentialProvider) => <span className="font-medium">{r.name}</span> },
    { key: 'vendor', header: 'Vendor', render: (r: CredentialProvider) => <VendorBadge vendor={getCredentialProviderVendor(r)} /> },
    { key: 'arn', header: 'ARN', render: (r: CredentialProvider) => <span className="text-xs font-mono text-text-muted">{truncateArn(r.credentialProviderArn)}</span> },
    { key: 'status', header: 'Status', render: (r: CredentialProvider) => <StatusBadge status={r.status || 'ACTIVE'} /> },
    { key: 'actions', header: '', className: 'w-32', render: (r: CredentialProvider) => (
      <div className="flex items-center gap-1 justify-end">
        <Button variant="ghost" size="sm" aria-label="View details" onClick={(e) => { e.stopPropagation(); setViewing(r) }}><Eye size={14} /></Button>
        <Button variant="ghost" size="sm" aria-label="Rotate credentials" onClick={(e) => { e.stopPropagation(); openEdit(r) }}><Pencil size={14} /></Button>
        <Button variant="ghost" size="sm" aria-label="Delete" onClick={(e) => { e.stopPropagation(); handleDelete(r.name, r.credentialProviderVendor) }}><Trash2 size={14} className="text-danger" /></Button>
      </div>
    )},
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">Credential Providers</h1>
          <p className="text-xs text-text-muted mt-0.5">Manage Coinbase CDP and Stripe/Privy credential providers</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading} icon={<RefreshCw size={14} />}>Refresh</Button>
          <Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Provider</Button>
        </div>
      </div>

      {error && <div className="rounded-lg bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>}

      <Card className="p-0 overflow-hidden">
        <DataTable columns={columns} data={credentialProviders} keyExtractor={(r) => r.name} onRowClick={setViewing}
          emptyState={<EmptyState icon={<KeyRound size={24} />} title="No credential providers" description="Create a credential provider (Coinbase or Stripe) to get started."
            action={<Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Provider</Button>} />} />
      </Card>

      <Dialog.Root open={creating} onOpenChange={setCreating}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <Dialog.Title className="text-base font-semibold text-text-primary">Create Credential Provider</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">Pick a vendor — the required fields will update automatically.</Dialog.Description>

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
                      onClick={() => setVendor(v)}
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
              <Input
                label="Provider Name"
                value={name}
                onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9\-_]/g, ''))}
                placeholder={vendor === 'CoinbaseCDP' ? 'my-coinbase-provider' : 'my-stripe-provider'}
              />
              {name && !/^[a-zA-Z0-9\-_]+$/.test(name) && <p className="text-xs text-danger">Only letters, digits, hyphens, underscores</p>}

              {vendor === 'CoinbaseCDP' ? (
                <>
                  <Input label="API Key ID" value={apiKeyId} onChange={(e) => setApiKeyId(e.target.value)} placeholder="UUID from CDP Portal" />
                  <Input label="API Key Secret" type="password" value={apiKeySecret} onChange={(e) => setApiKeySecret(e.target.value)} placeholder="••••••••" />
                  <Input label="Wallet Secret" type="password" value={walletSecret} onChange={(e) => setWalletSecret(e.target.value)} placeholder="••••••••" />
                </>
              ) : (
                <>
                  <Input label="App ID" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="App ID from Privy Dashboard" />
                  {appIdMismatch && (
                    <p className="rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning">
                      This App ID does not match the deployed <code className="font-mono">VITE_PRIVY_APP_ID</code>. The Connect Agent flow signs users into that Privy app, so the credential provider must use the same App ID or the agent operates against a different app than where the wallets live.
                    </p>
                  )}
                  <Input label="App Secret" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="••••••••" />
                  <Input label="Authorization Key ID" value={authorizationId} onChange={(e) => setAuthorizationId(e.target.value)} placeholder="P256 key ID from Privy Dashboard" />
                  {authIdMismatch && (
                    <p className="rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning">
                      This Authorization Key ID does not match the deployed <code className="font-mono">VITE_PRIVY_SIGNER_ID</code>. The Connect Agent flow delegates wallets to <code className="font-mono">VITE_PRIVY_SIGNER_ID</code>, so the agent can only sign if this credential provider uses the same authorization key.
                    </p>
                  )}
                  <Input label="Authorization Private Key" type="password" value={authorizationPrivateKey} onChange={(e) => setAuthorizationPrivateKey(e.target.value)} placeholder="••••••••" />
                  <p className="text-[10px] text-text-muted">Paste the P256 private key from the Privy dashboard. The <code className="font-mono">wallet-auth:</code> prefix is optional — the backend strips it.</p>
                </>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setCreating(false); resetForm() }}>Cancel</Button>
              <Button size="sm" onClick={handleCreate} disabled={!canSubmit}>
                {loading ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!editing} onOpenChange={(o) => !o && (setEditing(null), resetForm())}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <Dialog.Title className="text-base font-semibold text-text-primary">Rotate Credentials</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">
              The service replaces the entire secret set on update. Re-enter all vendor credentials to rotate.
            </Dialog.Description>

            <div className="mt-5 space-y-4">
              <Input label="Provider Name" value={name} disabled />
              <div className="flex items-center gap-2">
                <VendorBadge vendor={vendor} />
                <span className="text-[10px] text-text-muted">{vendorSubLabel(vendor)}</span>
              </div>

              {vendor === 'CoinbaseCDP' ? (
                <>
                  <Input label="API Key ID" value={apiKeyId} onChange={(e) => setApiKeyId(e.target.value)} placeholder="UUID from CDP Portal" />
                  <Input label="API Key Secret" type="password" value={apiKeySecret} onChange={(e) => setApiKeySecret(e.target.value)} placeholder="••••••••" />
                  <Input label="Wallet Secret" type="password" value={walletSecret} onChange={(e) => setWalletSecret(e.target.value)} placeholder="••••••••" />
                </>
              ) : (
                <>
                  <Input label="App ID" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="App ID from Privy Dashboard" />
                  {appIdMismatch && (
                    <p className="rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning">
                      This App ID does not match the deployed <code className="font-mono">VITE_PRIVY_APP_ID</code>. The Connect Agent flow signs users into that Privy app, so the credential provider must use the same App ID or the agent operates against a different app than where the wallets live.
                    </p>
                  )}
                  <Input label="App Secret" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="••••••••" />
                  <Input label="Authorization Key ID" value={authorizationId} onChange={(e) => setAuthorizationId(e.target.value)} placeholder="P256 key ID from Privy Dashboard" />
                  {authIdMismatch && (
                    <p className="rounded-lg bg-warning-muted px-3 py-2 text-xs text-warning">
                      This Authorization Key ID does not match the deployed <code className="font-mono">VITE_PRIVY_SIGNER_ID</code>. The Connect Agent flow delegates wallets to <code className="font-mono">VITE_PRIVY_SIGNER_ID</code>, so the agent can only sign if this credential provider uses the same authorization key.
                    </p>
                  )}
                  <Input label="Authorization Private Key" type="password" value={authorizationPrivateKey} onChange={(e) => setAuthorizationPrivateKey(e.target.value)} placeholder="••••••••" />
                </>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setEditing(null); resetForm() }}>Cancel</Button>
              <Button size="sm" onClick={handleUpdate} disabled={!canUpdate}>
                {loading ? 'Rotating…' : 'Rotate'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!viewing} onOpenChange={() => setViewing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Credential Provider Details</Dialog.Title>
            {viewing && (() => {
              const v = getCredentialProviderVendor(viewing)
              const cdp = viewing.providerConfigurationOutput?.coinbaseCdpConfiguration
              const sp = viewing.providerConfigurationOutput?.stripePrivyConfiguration
              const rows: [string, string | undefined][] = [
                ['Name', viewing.name],
                ['ARN', viewing.credentialProviderArn],
              ]
              if (v === 'CoinbaseCDP') {
                rows.push(['API Key ID', cdp?.apiKeyId])
                rows.push(['Secret ARN', cdp?.apiKeySecretArn?.secretArn])
                rows.push(['Wallet ARN', cdp?.walletSecretArn?.secretArn])
              } else if (v === 'StripePrivy') {
                rows.push(['App ID', sp?.appId])
                rows.push(['App Secret ARN', sp?.appSecretArn?.secretArn])
                rows.push(['Authorization Key ID', sp?.authorizationId])
                rows.push(['Authorization Private Key ARN', sp?.authorizationPrivateKeyArn?.secretArn])
              }
              return (
                <div className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center gap-2">
                    <VendorBadge vendor={v} />
                    <span className="text-[10px] text-text-muted">{vendorSubLabel(v)}</span>
                  </div>
                  {rows.map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4">
                      <span className="text-text-muted shrink-0">{label}</span>
                      <span className="text-text-primary font-mono text-xs text-right break-all">{value || '—'}</span>
                    </div>
                  ))}
                </div>
              )
            })()}
            <div className="mt-6 flex justify-end"><Button variant="secondary" size="sm" onClick={() => setViewing(null)}>Close</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
