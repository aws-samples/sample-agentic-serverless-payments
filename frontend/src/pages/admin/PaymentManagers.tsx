import { useState, useEffect } from 'react'
import { useAdminStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatDate } from '@/lib/utils'
import * as api from '@/lib/api'
import { CreditCard, Plus, Trash2, Eye, RefreshCw, Pencil } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { PaymentManager } from '@/types'

export function PaymentManagers() {
  const { paymentManagers, addPaymentManager, removePaymentManager, setPaymentManagers, updatePaymentManager } = useAdminStore()
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<PaymentManager | null>(null)
  const [editing, setEditing] = useState<PaymentManager | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Simplified form: just name + description. roleArn is backend-managed.
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [editDescription, setEditDescription] = useState('')

  const refresh = async () => {
    setLoading(true); setError('')
    try {
      const data = await api.listPaymentManagers()
      setPaymentManagers(data.paymentManagers || [])
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const { _prefetched } = useAdminStore()

  useEffect(() => { if (!_prefetched) refresh() }, [])

  const handleCreate = async () => {
    setLoading(true); setError('')
    try {
      const data = await api.createPaymentManager({ name, description })
      addPaymentManager(data)
      setCreating(false)
      setName(''); setDescription('')
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const handleDelete = async (id: string) => {
    try { await api.deletePaymentManager(id); removePaymentManager(id) }
    catch (err: any) { setError(err.message) }
  }

  const openEdit = (m: PaymentManager) => {
    setEditing(m)
    setEditDescription(m.description || '')
  }

  const handleUpdate = async () => {
    if (!editing) return
    setLoading(true); setError('')
    try {
      await api.updatePaymentManager(editing.paymentManagerId, { description: editDescription })
      updatePaymentManager(editing.paymentManagerId, { description: editDescription })
      setEditing(null)
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const columns = [
    { key: 'name', header: 'Name', render: (r: PaymentManager) => (
      <div><p className="font-medium">{r.name}</p>{r.description && <p className="text-xs text-text-muted mt-0.5">{r.description}</p>}</div>
    )},
    { key: 'id', header: 'ID', render: (r: PaymentManager) => <span className="text-xs font-mono text-text-muted">{r.paymentManagerId}</span> },
    { key: 'status', header: 'Status', render: (r: PaymentManager) => <StatusBadge status={r.status} /> },
    { key: 'created', header: 'Created', render: (r: PaymentManager) => <span className="text-xs text-text-muted">{r.createdAt ? formatDate(r.createdAt) : '—'}</span> },
    { key: 'actions', header: '', className: 'w-32', render: (r: PaymentManager) => (
      <div className="flex items-center gap-1 justify-end">
        <Button variant="ghost" size="sm" aria-label="View details" onClick={(e) => { e.stopPropagation(); setViewing(r) }}><Eye size={14} /></Button>
        <Button variant="ghost" size="sm" aria-label="Edit" onClick={(e) => { e.stopPropagation(); openEdit(r) }}><Pencil size={14} /></Button>
        <Button variant="ghost" size="sm" aria-label="Delete" onClick={(e) => { e.stopPropagation(); handleDelete(r.paymentManagerId) }}><Trash2 size={14} className="text-danger" /></Button>
      </div>
    )},
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">Payment Managers</h1>
          <p className="text-xs text-text-muted mt-0.5">Manage payment manager resources</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading} icon={<RefreshCw size={14} />}>Refresh</Button>
          <Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Manager</Button>
        </div>
      </div>

      {error && <div className="rounded-lg bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>}

      <Card className="p-0 overflow-hidden">
        <DataTable columns={columns} data={paymentManagers} keyExtractor={(r) => r.paymentManagerId} onRowClick={setViewing}
          emptyState={<EmptyState icon={<CreditCard size={24} />} title="No payment managers" description="Create a payment manager to orchestrate connectors and instruments."
            action={<Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Manager</Button>} />} />
      </Card>

      {/* Create — simplified: no roleArn, backend provisions it */}
      <Dialog.Root open={creating} onOpenChange={setCreating}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Create Payment Manager</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">
              Name must match [a-zA-Z][a-zA-Z0-9_]&#123;0,47&#125;. The IAM role is provisioned automatically.
            </Dialog.Description>
            <div className="mt-5 space-y-4">
              <Input label="Manager Name" value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} placeholder="MyPaymentManager" />
              {name && !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(name) && <p className="text-xs text-danger">Must start with a letter, only letters/digits/underscores, max 48 chars</p>}
              <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Production payment manager" />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setCreating(false); setName(''); setDescription('') }}>Cancel</Button>
              <Button size="sm" onClick={handleCreate} disabled={!name || loading}>{loading ? 'Creating…' : 'Create'}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Edit — description-only; service doesn't allow renaming */}
      <Dialog.Root open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Edit Payment Manager</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">Only the description can be edited. Name and role ARN are immutable.</Dialog.Description>
            <div className="mt-5 space-y-4">
              <Input label="Name" value={editing?.name || ''} disabled />
              <Input
                label="Description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value.replace(/[^a-zA-Z0-9\s]/g, ''))}
                placeholder="Production payment manager"
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

      {/* View details — shows roleArn as read-only */}
      <Dialog.Root open={!!viewing} onOpenChange={() => setViewing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Payment Manager Details</Dialog.Title>
            {viewing && (
              <div className="mt-4 space-y-3 text-sm">
                {([['Name', viewing.name], ['ID', viewing.paymentManagerId], ['ARN', viewing.paymentManagerArn],
                  ['Auth Type', viewing.authorizerType], ['Role ARN', viewing.roleArn], ['Status', viewing.status],
                  ['Created', viewing.createdAt ? formatDate(viewing.createdAt) : undefined],
                ] as [string, string | undefined][]).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <span className="text-text-muted shrink-0">{label}</span>
                    <span className="text-text-primary font-mono text-xs text-right break-all">{value || '—'}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-6 flex justify-end"><Button variant="secondary" size="sm" onClick={() => setViewing(null)}>Close</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
