// Admin Seller Orders view. Displays storefront order and refund records.
// Compliance: orders settle in stablecoin (USDC); no payment card data is
// handled here. Apply access controls, retention, and audit logging
// appropriate to financial records before production use.
import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatDate } from '@/lib/utils'
import * as api from '@/lib/api'
import { ShoppingBag, RefreshCw, Undo2, AlertTriangle } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'

export function SellerOrders() {
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refunding, setRefunding] = useState<string>('')
  const [error, setError] = useState('')
  // Force-refund confirm dialog for a downloaded (non-refundable) order.
  const [forceTarget, setForceTarget] = useState<any | null>(null)

  const refresh = async () => {
    setLoading(true); setError('')
    try {
      const r = await api.listStoreOrders()
      const list = (r.orders || []).sort((a, b) =>
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      setOrders(list)
    } catch (e: any) {
      setError(e.message || 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const handleRefund = async (orderId: string, force = false) => {
    setRefunding(orderId); setError('')
    try {
      await api.refundStoreOrder(orderId, force)
      setForceTarget(null)
      await refresh()
    } catch (e: any) {
      setError(e.message || 'Refund failed')
    } finally {
      setRefunding('')
    }
  }

  const columns = [
    { key: 'orderId', header: 'Order', render: (r: any) => <span className="text-xs font-mono">{r.orderId?.slice(0, 18)}…</span> },
    { key: 'item', header: 'Item', render: (r: any) => <span className="text-xs">{r.items?.[0]?.name || '—'} ×{r.items?.[0]?.qty || 1}</span> },
    { key: 'amount', header: 'Amount', render: (r: any) => <span className="text-xs font-semibold text-accent">${Number(r.amountUsd).toFixed(2)}</span> },
    { key: 'network', header: 'Network', render: (r: any) => <span className="rounded bg-surface-3 px-2 py-0.5 text-[10px] font-mono">{r.network === 'SOLANA' ? 'Solana' : 'Base Sepolia'}</span> },
    { key: 'status', header: 'Status', render: (r: any) => (
      <div className="flex items-center gap-1.5">
        <StatusBadge status={r.status} />
        {r.downloaded === true && (
          <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium text-text-muted" title="Buyer downloaded the file">downloaded</span>
        )}
        {r.forcedRefund === true && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300" title="Refunded after download (admin override)">forced</span>
        )}
      </div>
    ) },
    { key: 'created', header: 'Created', render: (r: any) => <span className="text-[11px] text-text-muted">{r.createdAt ? formatDate(r.createdAt) : '—'}</span> },
    { key: 'actions', header: '', className: 'w-32', render: (r: any) => {
      if (r.status !== 'CONFIRMED') {
        return r.status === 'REFUNDED' ? <span className="text-[10px] text-text-muted">refunded</span> : null
      }
      // Downloaded → non-refundable via the normal path; admin can force.
      if (r.downloaded === true) {
        return (
          <Button variant="ghost" size="sm" disabled={refunding === r.orderId}
            onClick={(e) => { e.stopPropagation(); setForceTarget(r) }}>
            <AlertTriangle size={14} className="text-amber-400" />
            Force refund
          </Button>
        )
      }
      return (
        <Button variant="ghost" size="sm" disabled={refunding === r.orderId}
          onClick={(e) => { e.stopPropagation(); handleRefund(r.orderId) }}>
          <Undo2 size={14} className="text-danger" />
          {refunding === r.orderId ? 'Refunding…' : 'Refund'}
        </Button>
      )
    }},
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <ShoppingBag size={18} /> Orders
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            Orders placed by agents through the storefront. Refund a confirmed order to trigger a
            seller-originated reverse payment (governed by a spend-capped refund session).
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={refresh} icon={<RefreshCw size={14} />}>Refresh</Button>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <Card className="p-0 overflow-hidden">
        <DataTable
          columns={columns}
          data={orders}
          keyExtractor={(r) => r.orderId}
          emptyState={
            <EmptyState
              icon={<ShoppingBag size={24} />}
              title={loading ? 'Loading orders…' : 'No orders yet'}
              description="When an agent buys from the storefront, the order appears here."
            />
          }
        />
      </Card>

      {/* Force-refund confirmation — the buyer already downloaded the file */}
      <Dialog.Root open={!!forceTarget} onOpenChange={(o) => { if (!o) setForceTarget(null) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface-1 p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                <AlertTriangle size={18} className="text-amber-400" />
              </div>
              <div>
                <Dialog.Title className="text-sm font-semibold text-text-primary">Force refund a downloaded order?</Dialog.Title>
                <Dialog.Description className="mt-1 text-xs leading-relaxed text-text-muted">
                  The buyer already downloaded this file, so it is normally non-refundable.
                  Forcing the refund will still send {forceTarget ? `$${Number(forceTarget.amountUsd).toFixed(2)}` : ''} back
                  to the buyer from the seller wallet, even though they keep the downloaded copy.
                  This override is recorded on the order.
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setForceTarget(null)}>Cancel</Button>
              <Button
                size="sm"
                disabled={refunding === forceTarget?.orderId}
                onClick={() => handleRefund(forceTarget.orderId, true)}
              >
                {refunding === forceTarget?.orderId ? 'Refunding…' : 'Force refund'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
