/**
 * VendorBadge — color-coded pill identifying which payments vendor a resource
 * belongs to (Coinbase CDP or Stripe/Privy). Reused across admin + user pages.
 */
import { cn, vendorLabel } from '@/lib/utils'
import type { Vendor } from '@/types'

interface Props {
  vendor: Vendor | string | null | undefined
  className?: string
  /** "compact" hides the icon; "full" shows it. */
  size?: 'sm' | 'md'
}

const VENDOR_STYLES: Record<Vendor, { ring: string; bg: string; text: string; dot: string }> = {
  CoinbaseCDP: {
    ring: 'ring-amber-500/30',
    bg: 'bg-amber-500/10',
    text: 'text-amber-500',
    dot: 'bg-amber-500',
  },
  StripePrivy: {
    ring: 'ring-indigo-500/30',
    bg: 'bg-indigo-500/10',
    text: 'text-indigo-400',
    dot: 'bg-indigo-500',
  },
}

export function VendorBadge({ vendor, className, size = 'md' }: Props) {
  const v = vendor as Vendor
  const style = VENDOR_STYLES[v]
  const label = vendorLabel(v)

  if (!style) {
    // Unknown / legacy — neutral pill
    return (
      <span className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-text-muted ring-1 ring-border',
        size === 'sm' && 'px-1.5 text-[9px]',
        className,
      )}>
        {label}
      </span>
    )
  }

  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1',
      style.ring,
      style.bg,
      style.text,
      size === 'sm' && 'px-1.5 text-[9px]',
      className,
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} aria-hidden="true" />
      {label}
    </span>
  )
}
