import { useState, useEffect, useMemo } from 'react'
import { useAdminStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { VendorBadge } from '@/components/ui/VendorBadge'
import {
  getConnectorVendor,
  getCredentialProviderVendor,
  vendorSubLabel,
} from '@/lib/utils'
import * as api from '@/lib/api'
import { Link2, Plus, Trash2, Eye, RefreshCw, Pencil } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { PaymentConnector } from '@/types'

export function PaymentConnectors() {
  const { paymentConnectors, paymentManagers, credentialProviders, addPaymentConnector, removePaymentConnector, setPaymentConnectors, updatePaymentConnector } = useAdminStore()
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<PaymentConnector | null>(null)
  const [editing, setEditing] = useState<PaymentConnector | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [managerId, setManagerId] = useState('')
  const [providerArn, setProviderArn] = useState('')
  const [editDescription, setEditDescription] = useState('')

  // Vendor is derived from the currently-selected credential provider.
  const selectedProvider = useMemo(
    () => credentialProviders.find((p) => p.credentialProviderArn === providerArn),
    [providerArn, credentialProviders],
  )
  const selectedVendor = selectedProvider ? getCredentialProviderVendor(selectedProvider) : null

  const refresh = async () => {
    setLoading(true); setError('')
    try {
      const all: PaymentConnector[] = []
      for (const m of paymentManagers) {
        try {
          const data = await api.listPaymentConnectors(m.paymentManagerId)
          const connectors = (data.paymentConnectors || []).map((c: any) => ({ ...c, paymentManagerId: m.paymentManagerId }))
          all.push(...connectors)
        } catch { /* skip managers with no connectors */ }
      }
      setPaymentConnectors(all)
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const { _prefetched } = useAdminStore()

  useEffect(() => {
    if (paymentManagers.length > 0 && !_prefetched) refresh()
  }, [paymentManagers.length])

  const handleCreate = async () => {
    if (!selectedVendor) {
      setError('Selected credential provider has no recognized vendor')
      return
    }
    setLoading(true); setError('')
    try {
      const data = await api.createPaymentConnector({
        paymentManagerId: managerId,
        name,
        description,
        type: selectedVendor,
        credentialProviderArn: providerArn,
      })
      addPaymentConnector({ ...data, paymentManagerId: managerId })
      setCreating(false)
      resetForm()
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const handleDelete = async (mId: string, cId: string) => {
    try { await api.deletePaymentConnector(mId, cId); removePaymentConnector(mId, cId) }
    catch (err: any) { setError(err.message) }
  }

  const openEdit = (c: PaymentConnector) => {
    setEditing(c)
    setEditDescription(c.description || '')
  }

  const handleUpdate = async () => {
    if (!editing) return
    setLoading(true); setError('')
    try {
      await api.updatePaymentConnector(editing.paymentManagerId, editing.paymentConnectorId, {
        description: editDescription,
      })
      updatePaymentConnector(editing.paymentManagerId, editing.paymentConnectorId, { description: editDescription })
      setEditing(null)
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const resetForm = () => { setName(''); setDescription(''); setManagerId(''); setProviderArn('') }

  const columns = [
    { key: 'name', header: 'Name', render: (r: PaymentConnector) => (
      <div><p className="font-medium">{r.name}</p>{r.description && <p className="text-xs text-text-muted mt-0.5">{r.description}</p>}</div>
    )},
    { key: 'type', header: 'Vendor', render: (r: PaymentConnector) => <VendorBadge vendor={getConnectorVendor(r)} /> },
    { key: 'manager', header: 'Manager', render: (r: PaymentConnector) => <span className="text-xs font-mono text-text-muted">{r.paymentManagerId}</span> },
    { key: 'status', header: 'Status', render: (r: PaymentConnector) => <StatusBadge status={r.status} /> },
    { key: 'actions', header: '', className: 'w-32', render: (r: PaymentConnector) => (
      <div className="flex items-center gap-1 justify-end">
        <Button variant="ghost" size="sm" aria-label="View details" onClick={(e) => { e.stopPropagation(); setViewing(r) }}><Eye size={14} /></Button>
        <Button variant="ghost" size="sm" aria-label="Edit" onClick={(e) => { e.stopPropagation(); openEdit(r) }}><Pencil size={14} /></Button>
        <Button variant="ghost" size="sm" aria-label="Delete" onClick={(e) => { e.stopPropagation(); handleDelete(r.paymentManagerId, r.paymentConnectorId) }}><Trash2 size={14} className="text-danger" /></Button>
      </div>
    )},
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">Payment Connectors</h1>
          <p className="text-xs text-text-muted mt-0.5">Bridge managers to credential providers</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading} icon={<RefreshCw size={14} />}>Refresh</Button>
          <Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Connector</Button>
        </div>
      </div>

      {error && <div className="rounded-lg bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>}

      <Card className="p-0 overflow-hidden">
        <DataTable columns={columns} data={paymentConnectors} keyExtractor={(r) => `${r.paymentManagerId}-${r.paymentConnectorId}`} onRowClick={setViewing}
          emptyState={<EmptyState icon={<Link2 size={24} />} title="No payment connectors" description="Create a connector to link a manager with a credential provider."
            action={<Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Connector</Button>} />} />
      </Card>

      <Dialog.Root open={creating} onOpenChange={setCreating}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Create Payment Connector</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">The connector vendor is inferred from the credential provider you pick.</Dialog.Description>
            <div className="mt-5 space-y-4">
              <Input label="Connector Name" value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9\-_]/g, ''))} placeholder="MyConnector" />
              {name && !/^[a-zA-Z0-9\-_]+$/.test(name) && <p className="text-xs text-danger">Only letters, digits, hyphens, underscores</p>}
              <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value.replace(/[^a-zA-Z0-9\s]/g, ''))} placeholder="Connector description" />
              {description && !/^[a-zA-Z0-9\s]+$/.test(description) && <p className="text-xs text-danger">Only letters, digits, spaces</p>}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-text-secondary">Payment Manager</label>
                <select className="flex h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                  value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                  <option value="">Select a manager…</option>
                  {paymentManagers.map((m) => <option key={m.paymentManagerId} value={m.paymentManagerId}>{m.name} ({m.paymentManagerId})</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-text-secondary">Credential Provider</label>
                <select className="flex h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                  value={providerArn} onChange={(e) => setProviderArn(e.target.value)}>
                  <option value="">Select a provider…</option>
                  {credentialProviders.map((p) => {
                    const v = getCredentialProviderVendor(p)
                    const label = v === 'StripePrivy' ? 'Stripe' : v === 'CoinbaseCDP' ? 'Coinbase' : (p.credentialProviderVendor || 'Unknown')
                    return (
                      <option key={p.name} value={p.credentialProviderArn}>
                        {p.name} · {label}
                      </option>
                    )
                  })}
                </select>
                {selectedVendor && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[10px] text-text-muted">Connector type:</span>
                    <VendorBadge vendor={selectedVendor} size="sm" />
                    <span className="text-[10px] text-text-muted">{vendorSubLabel(selectedVendor)}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setCreating(false); resetForm() }}>Cancel</Button>
              <Button size="sm" onClick={handleCreate} disabled={!name || !managerId || !providerArn || !selectedVendor || loading}>{loading ? 'Creating…' : 'Create'}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Edit Payment Connector</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">Only the description can be edited. To repoint at different credentials, recreate the connector.</Dialog.Description>
            <div className="mt-5 space-y-4">
              <Input label="Name" value={editing?.name || ''} disabled />
              <Input
                label="Description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value.replace(/[^a-zA-Z0-9\s]/g, ''))}
                placeholder="Connector description"
              />
              {editDescription && !/^[a-zA-Z0-9\s]+$/.test(editDescription) && (
                <p className="text-xs text-danger">Only letters, digits, spaces</p>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
              <Button size="sm" onClick={handleUpdate} disabled={loading}>{loading ? 'Saving…' : 'Save'}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!viewing} onOpenChange={() => setViewing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Connector Details</Dialog.Title>
            {viewing && (() => {
              const v = getConnectorVendor(viewing)
              const cfg = viewing.credentialProviderConfigurations?.[0] || {}
              const providerArn = cfg.coinbaseCDP?.credentialProviderArn || cfg.stripePrivy?.credentialProviderArn
              return (
                <div className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center gap-2">
                    <VendorBadge vendor={v} />
                    <span className="text-[10px] text-text-muted">{vendorSubLabel(v)}</span>
                  </div>
                  {([['Name', viewing.name], ['Connector ID', viewing.paymentConnectorId], ['Manager ID', viewing.paymentManagerId],
                    ['Description', viewing.description], ['Status', viewing.status],
                    ['Provider ARN', providerArn],
                  ] as [string, string | undefined][]).map(([label, value]) => (
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
