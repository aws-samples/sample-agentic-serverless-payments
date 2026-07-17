// Buyer library: displays the caller's digital purchases + saved media (order
// and purchase history). Settlement is stablecoin (USDC); no payment card data
// is handled here. If extended to card payments, PCI-DSS controls would apply.
import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import * as api from '@/lib/api'
import { Library as LibraryIcon, Download, RefreshCw, FileText, Image as ImageIcon, AlertTriangle } from 'lucide-react'

const STOREFRONT_API = (import.meta.env.VITE_STOREFRONT_API_URL as string) || ''

type PurchaseItem = {
  kind: 'purchase'
  orderId: string
  name: string
  productId: string
  purchasedAt: string
  downloaded: boolean
  refundable: boolean
}
type GeneratedItem = {
  kind: 'generated'
  key: string
  name: string
  size: number
  createdAt: string
  url: string
}
type LibraryItem = PurchaseItem | GeneratedItem

function isImage(name: string) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
}

export function Library() {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await api.getLibrary()
      setItems((r.items || []) as LibraryItem[])
    } catch (e: any) {
      setError(e.message || 'Failed to load library')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const downloadHref = (orderId: string) =>
    `${STOREFRONT_API.replace(/\/+$/, '')}/orders/${orderId}/download`

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <LibraryIcon size={18} /> Library
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            Your purchased digital goods and saved generated images. Downloading a purchased file makes it non-refundable.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {error && (
        <Card><p className="text-sm text-danger">{error}</p></Card>
      )}

      {loading ? (
        <Card><p className="text-sm text-text-muted">Loading library…</p></Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<LibraryIcon size={24} />}
          title="Your library is empty"
          description="Buy a digital product or generate an image with the agent, and it will appear here."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item) => (
            item.kind === 'generated' ? (
              <Card key={item.key} className="flex flex-col gap-3">
                <div className="aspect-video rounded-lg bg-surface-2 flex items-center justify-center overflow-hidden">
                  {isImage(item.name) ? (
                    <img src={item.url} alt={item.name} className="w-full h-full object-cover" />
                  ) : (
                    <FileText size={32} className="text-text-muted" />
                  )}
                </div>
                <div className="flex items-start gap-2">
                  <ImageIcon size={14} className="text-accent mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{item.name}</p>
                    <p className="text-[11px] text-text-muted">Generated image</p>
                  </div>
                </div>
                <a
                  href={item.url}
                  download={item.name}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20"
                >
                  <Download size={13} /> Download
                </a>
              </Card>
            ) : (
              <Card key={item.orderId} className="flex flex-col gap-3">
                <div className="aspect-video rounded-lg bg-surface-2 flex items-center justify-center">
                  <FileText size={32} className="text-text-muted" />
                </div>
                <div className="flex items-start gap-2">
                  <FileText size={14} className="text-accent mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{item.name}</p>
                    <p className="text-[11px] text-text-muted">Purchased</p>
                  </div>
                </div>
                {item.refundable ? (
                  <div className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5">
                    <AlertTriangle size={12} className="text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-[11px] text-amber-300 leading-snug">
                      Downloading makes this order non-refundable.
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-text-muted px-0.5">Downloaded · non-refundable</p>
                )}
                <a
                  href={downloadHref(item.orderId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 rounded-lg bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20"
                >
                  <Download size={13} /> Download
                </a>
              </Card>
            )
          ))}
        </div>
      )}
    </div>
  )
}
