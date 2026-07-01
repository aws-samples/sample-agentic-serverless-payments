import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface KpiCardProps {
  label: string
  value: string | number
  icon: ReactNode
  trend?: { value: string; positive: boolean }
  loading?: boolean
  className?: string
}

export function KpiCard({ label, value, icon, trend, loading, className }: KpiCardProps) {
  return (
    <div className={cn(
      'rounded-xl border border-border bg-surface-1 p-5 flex items-start justify-between',
      className,
    )}>
      <div>
        <p className="text-xs font-medium text-text-muted uppercase tracking-wider">{label}</p>
        {loading ? (
          <div className="mt-2 h-8 w-12 animate-pulse rounded bg-surface-3" />
        ) : (
          <p className="mt-2 text-2xl font-bold text-text-primary tabular-nums">{value}</p>
        )}
        {trend && (
          <p className={cn('mt-1 text-xs font-medium', trend.positive ? 'text-success' : 'text-danger')}>
            {trend.positive ? '↑' : '↓'} {trend.value}
          </p>
        )}
      </div>
      <div className="rounded-lg bg-accent-muted p-2.5 text-accent">{icon}</div>
    </div>
  )
}
