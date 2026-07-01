import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatDate } from '@/lib/utils'
import * as api from '@/lib/api'
import { Receipt, RefreshCw, Package, FileDown } from 'lucide-react'

type OrderRow = {
  orderId: string
  name: string
  quantity: number
  amountUsd: number
  network: string
  fulfillmentType: string
  status: string
  downloaded: boolean
  shippingAddress: string
  estimatedDelivery: string
  refundedAt: string
  forcedRefund: boolean
  createdAt: string
}

export function Orders() {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = async () => {
    setLoading(true); setError('')
    try {
      const r = await api.getOrderHistory()
      setOrders((r.orders || []) as OrderRow[])
    } catch (e: any) {
      setError(e.message || 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const columns = [
    {
      key: 'orderId', header: 'Order ID', render: (r: OrderRow) => (
        <span
          className="font-mono text-[10px] text-text-muted select-all cursor-text"
          title="Click to select, then copy — give this to the agent to refund this order"
        >
          {r.orderId}
        </span>
      ),
    },
    {
      key: 'item', header: 'Item', render: (r: OrderRow) => (
        <div className="flex items-center gap-2">
          {r.fulfillmentType === 'physical'
            ? <Package size={14} className="text-text-muted shrink-0" />
            : <FileDown size={14} className="text-text-muted shrink-0" />}
          <span className="text-xs">{r.name || '—'}{r.quantity > 1 ? ` ×${r.quantity}` : ''}</span>
        </div>
      ),
    },
    { key: 'type', header: 'Type', render: (r: OrderRow) => (
      <span className="rounded bg-surface-3 px-2 py-0.5 text-[10px] capitalize">{r.fulfillmentType}</span>
    ) },
    { key: 'amount', header: 'Amount', render: (r: OrderRow) => (
      <span className="text-xs font-semibold text-accent">${Number(r.amountUsd).toFixed(2)} USDC</span>
    ) },
    { key: 'network', header: 'Network', render: (r: OrderRow) => (
      <span className="text-[11px] text-text-muted">{r.network === 'SOLANA' ? 'Solana' : 'Base Sepolia'}</span>
    ) },
    { key: 'status', header: 'Status', render: (r: OrderRow) => (
      <div className="flex items-center gap-1.5">
        <StatusBadge status={r.status} />
        {r.fulfillmentType === 'digital' && r.status === 'CONFIRMED' && r.downloaded && (
          <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] text-text-muted">downloaded</span>
        )}
        {r.forcedRefund && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-300">forced</span>
        )}
      </div>
    ) },
    { key: 'detail', header: 'Detail', render: (r: OrderRow) => (
      <span className="text-[11px] text-text-muted">
        {r.fulfillmentType === 'physical'
          ? (r.shippingAddress ? r.shippingAddress : (r.estimatedDelivery || '—'))
          : (r.status === 'REFUNDED' ? 'removed from library' : 'in library')}
      </span>
    ) },
    { key: 'date', header: 'Date', render: (r: OrderRow) => (
      <span className="text-[11px] text-text-muted">{r.createdAt ? formatDate(r.createdAt) : '—'}</span>
    ) },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <Receipt size={18} /> Order History
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            Every purchase you have made through the agent, physical and digital, with its current status.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {error && <Card><p className="text-sm text-danger">{error}</p></Card>}

      <Card className="p-0 overflow-hidden">
        <DataTable
          columns={columns}
          data={orders}
          keyExtractor={(r) => r.orderId}
          emptyState={
            <EmptyState
              icon={<Receipt size={24} />}
              title={loading ? 'Loading orders…' : 'No orders yet'}
              description="Ask the agent to buy something from the storefront and it will show up here."
            />
          }
        />
      </Card>
    </div>
  )
}
