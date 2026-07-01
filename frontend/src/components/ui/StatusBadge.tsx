import { cn, statusBadgeClasses } from '@/lib/utils'

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide uppercase',
      statusBadgeClasses(status),
      className,
    )}>
      {status || 'UNKNOWN'}
    </span>
  )
}
