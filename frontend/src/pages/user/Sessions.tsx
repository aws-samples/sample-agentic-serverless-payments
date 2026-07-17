// Data protection: this page creates and lists AgentCore payment sessions
// (spending limits, spent/remaining amounts on public testnet instruments). It
// handles no payment card data, so PCI-DSS does not apply to this sample.
// Production deployments should apply access control, retention, and audit
// controls appropriate to their environment.
import { useState, useEffect } from 'react'
import { useUserStore, useAdminStore } from '@/store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatDate } from '@/lib/utils'
import * as api from '@/lib/api'
import { Clock, Plus, Eye, RefreshCw, Trash2 } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { PaymentSession } from '@/types'

// Pull budget/spent/remaining off a session record (live or static). The live
// GetPaymentSession response carries availableLimits.availableSpendAmount
// (REMAINING), not a spent field. We derive spent = budget − remaining. The
// static list row has no availability, so remaining defaults to the full
// budget until enriched.
function budgetView(s: any) {
  const budget = parseFloat(s?.limits?.maxSpendAmount?.value ?? '') || 0
  const currency = s?.limits?.maxSpendAmount?.currency || 'USD'
  const avail = s?.availableLimits?.availableSpendAmount?.value
  const remaining = avail != null ? Math.max(0, parseFloat(avail) || 0) : budget
  const spent = Math.max(0, budget - remaining)
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0
  return { budget, spent, remaining, currency, pct }
}

function MiniBar({ pct }: { pct: number }) {
  const danger = pct >= 90
  const warn = pct >= 70 && pct < 90
  return (
    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-3">
      <div
        className={
          danger ? 'h-full bg-danger' : warn ? 'h-full bg-amber-400' : 'h-full bg-success'
        }
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function Sessions() {
  const { sessions, addSession, setSessions, removeSession } = useUserStore()
  const { paymentManagers } = useAdminStore()
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<PaymentSession | null>(null)
  const [liveSession, setLiveSession] = useState<PaymentSession | null>(null)
  // Live spend per session id, enriched via GetPaymentSession so the list
  // shows real remaining budget at a glance (not just the static limit).
  const [liveSpend, setLiveSpend] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Confirm-revoke dialog state — hard delete, so we gate it behind an
  // explicit confirmation rather than doing it inline on the row.
  const [revoking, setRevoking] = useState<PaymentSession | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)

  // Simplified: pick manager, set budget + expiry. userId injected by backend.
  const [managerArn, setManagerArn] = useState('')
  const [maxSpend, setMaxSpend] = useState('1.0')
  const [currency, setCurrency] = useState('USD')
  const [expiryMinutes, setExpiryMinutes] = useState('15')

  // The service's list response shape matches the frontend's PaymentSession
  // type directly — no normalization needed. If future shape drift shows up,
  // handle it here.
  const refresh = async () => {
    setLoading(true); setError('')
    try {
      const managerArns = paymentManagers.map((m) => m.paymentManagerArn).filter(Boolean)
      // Sessions are scoped server-side to the caller's Cognito sub, so a
      // single list per manager surfaces all of this user's sessions.
      const data = await api.listAllSessions(managerArns)
      setSessions(data.paymentSessions || [])
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const { _prefetched } = useUserStore()

  useEffect(() => { if (!_prefetched) refresh() }, [])

  // Enrich the visible sessions with live spend (GetPaymentSession) so the
  // list can show real remaining budget. Best-effort, parallel, re-runs when
  // the session set changes.
  useEffect(() => {
    let cancelled = false
    const active = sessions.filter((s) => s.paymentSessionId && s.paymentManagerArn)
    if (active.length === 0) { setLiveSpend({}); return }
    Promise.allSettled(
      active.map((s) =>
        api.getSession(s.paymentSessionId, s.paymentManagerArn)
          .then((res) => ({ id: s.paymentSessionId, data: res.paymentSession ?? res }))
      )
    ).then((results) => {
      if (cancelled) return
      const map: Record<string, any> = {}
      for (const r of results) {
        if (r.status === 'fulfilled') map[r.value.id] = r.value.data
      }
      setLiveSpend(map)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  // Fetch live session details (spend tracking) when viewing
  useEffect(() => {
    if (!viewing) { setLiveSession(null); return }
    let cancelled = false
    api.getSession(viewing.paymentSessionId, viewing.paymentManagerArn)
      .then((res) => {
        if (cancelled) return
        setLiveSession(res.paymentSession ?? res)
      })
      .catch(() => { if (!cancelled) setLiveSession(null) })
    return () => { cancelled = true }
  }, [viewing])

  // Auto-select manager if only one exists
  useEffect(() => {
    if (paymentManagers.length === 1 && !managerArn) {
      setManagerArn(paymentManagers[0].paymentManagerArn)
    }
  }, [paymentManagers])

  const handleCreate = async () => {
    setLoading(true); setError('')
    try {
      const data = await api.createSession({
        paymentManagerArn: managerArn,
        maxSpendAmount: { value: maxSpend, currency },
        expiryTimeInMinutes: parseInt(expiryMinutes, 10),
      })
      const session = data.paymentSession || data
      // Defensive fallback in case the caller didn't echo the field back.
      if (!session.expiryTimeInMinutes) {
        session.expiryTimeInMinutes = parseInt(expiryMinutes, 10) || 15
      }
      addSession(session)
      setCreating(false)
      resetForm()
    } catch (err: any) { setError(err.message) }
    finally { setLoading(false) }
  }

  const resetForm = () => { setManagerArn(paymentManagers.length === 1 ? paymentManagers[0].paymentManagerArn : ''); setMaxSpend('1.0'); setCurrency('USD'); setExpiryMinutes('15') }

  const handleRevoke = async () => {
    if (!revoking) return
    setRevokeBusy(true); setError('')
    try {
      await api.deleteSession(revoking.paymentSessionId, {
        managerArn: revoking.paymentManagerArn,
      })
      removeSession(revoking.paymentSessionId)
      setRevoking(null)
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke session')
    } finally {
      setRevokeBusy(false)
    }
  }

  const columns = [
    { key: 'id', header: 'Session ID', render: (r: PaymentSession) => <span className="text-xs font-mono">{r.paymentSessionId}</span> },
    { key: 'budget', header: 'Budget', render: (r: PaymentSession) => {
      // The list summary has no limits; the live record (liveSpend) does.
      const b = (liveSpend[r.paymentSessionId]?.limits?.maxSpendAmount) || r.limits?.maxSpendAmount
      return (
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold tabular-nums">{b?.value || '—'}</span>
          <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-mono uppercase">{b?.currency || ''}</span>
        </div>
      )
    }},
    { key: 'remaining', header: 'Remaining', render: (r: PaymentSession) => {
      const live = liveSpend[r.paymentSessionId]
      // Merge the live record (carries availableLimits) over the static row so
      // budgetView can read remaining; fall back to the static row before load.
      const v = budgetView(live ? { ...r, ...live } : r)
      if (!v.budget) return <span className="text-xs text-text-muted">—</span>
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs tabular-nums text-text-secondary">
            {v.remaining.toFixed(2)} / {v.budget.toFixed(2)} {v.currency}
          </span>
          <MiniBar pct={v.pct} />
        </div>
      )
    }},
    { key: 'expiry', header: 'Expiry', render: (r: PaymentSession) => <span className="text-xs text-text-muted">{r.expiryTimeInMinutes || 0}m</span> },
    { key: 'created', header: 'Created', render: (r: PaymentSession) => <span className="text-xs text-text-muted">{r.createdAt ? formatDate(r.createdAt) : '—'}</span> },
    { key: 'actions', header: '', className: 'w-24', render: (r: PaymentSession) => (
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Revoke session"
          title="Revoke session (permanent)"
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); setRevoking(r) }}
        >
          <Trash2 size={14} className="text-danger" />
        </Button>
        <Button variant="ghost" size="sm" aria-label="View details" onClick={(e: React.MouseEvent) => { e.stopPropagation(); setViewing(r) }}><Eye size={14} /></Button>
      </div>
    )},
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">My Sessions</h1>
          <p className="text-xs text-text-muted mt-0.5">Payment sessions with spend budgets</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={refresh} disabled={loading} icon={<RefreshCw size={14} />}>Refresh</Button>
            <Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Session</Button>
          </div>
        </div>
      </div>

      {error && <div className="rounded-lg bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>}

      <Card className="p-0 overflow-hidden">
        <DataTable columns={columns} data={sessions} keyExtractor={(r) => r.paymentSessionId} onRowClick={setViewing}
          emptyState={<EmptyState icon={<Clock size={24} />} title="No sessions" description="Create a payment session with a spend budget for your agent."
            action={<Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} />}>Create Session</Button>} />} />
      </Card>

      {/* Create — simplified: no userId field, backend injects from Cognito */}
      <Dialog.Root open={creating} onOpenChange={setCreating}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Create Payment Session</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">Set a spend budget and expiry. Your identity is resolved from your login.</Dialog.Description>
            <div className="mt-5 space-y-4">
              {paymentManagers.length > 1 && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-text-secondary">Payment Manager</label>
                  <select className="flex h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                    value={managerArn} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setManagerArn(e.target.value)}>
                    <option value="">Select a manager…</option>
                    {paymentManagers.map((m) => <option key={m.paymentManagerId} value={m.paymentManagerArn}>{m.name}</option>)}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Input label="Max Spend" value={maxSpend} onChange={(e) => setMaxSpend(e.target.value)} placeholder="1.0" />
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-text-secondary">Currency</label>
                  <select className="flex h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                    value={currency} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCurrency(e.target.value)}>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>
              <Input
                label="Expiry (minutes) — min 15, max 480"
                value={expiryMinutes}
                onChange={(e) => setExpiryMinutes(e.target.value)}
                placeholder="15"
                type="number"
                min={15}
                max={480}
              />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setCreating(false); resetForm() }}>Cancel</Button>
              <Button size="sm" onClick={handleCreate} disabled={!managerArn || !maxSpend || loading}>{loading ? 'Creating…' : 'Create'}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!viewing} onOpenChange={() => setViewing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Session Details</Dialog.Title>
            {viewing && (
              <div className="mt-4 space-y-3 text-sm">
                {([['Session ID', viewing.paymentSessionId],
                  // The session APIs return no explicit status field, so derive
                  // it from expiry. Budget comes from the LIVE record (the list
                  // summary has no limits) — fall back to the static row.
                  ['Status', (() => {
                    // No explicit status field on the API — derive from expiry.
                    const created = viewing.createdAt ? new Date(viewing.createdAt).getTime() : 0
                    const expMs = (viewing.expiryTimeInMinutes || 15) * 60 * 1000
                    const expired = created > 0 && Date.now() > created + expMs
                    return expired ? 'Expired' : 'Active'
                  })()],
                  ['Budget', (() => {
                    const src = liveSession ?? viewing
                    const b = src.limits?.maxSpendAmount
                    return b?.value ? `${b.value} ${b.currency || ''}`.trim() : undefined
                  })()],
                  ['Spent', (() => {
                    const v = budgetView(liveSession ? { ...viewing, ...liveSession } : viewing)
                    return v.budget ? `${v.spent.toFixed(2)} ${v.currency}` : '0'
                  })()],
                  ['Remaining', (() => {
                    const v = budgetView(liveSession ? { ...viewing, ...liveSession } : viewing)
                    return v.budget ? `${v.remaining.toFixed(2)} ${v.currency}` : undefined
                  })()],
                  ['Expiry', `${viewing.expiryTimeInMinutes || 0} minutes`],
                  ['Created', viewing.createdAt ? formatDate(viewing.createdAt) : undefined],
                ] as [string, string | undefined][]).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4">
                    <span className="text-text-muted shrink-0">{label}</span>
                    <span className="text-text-primary font-mono text-xs text-right break-all">{value || '—'}</span>
                  </div>
                ))}
                {(() => {
                  const v = budgetView(liveSession ? { ...viewing, ...liveSession } : viewing)
                  if (!v.budget) return null
                  return (
                    <div className="pt-1">
                      <MiniBar pct={v.pct} />
                      <p className="mt-1 text-[11px] text-text-muted">{v.pct.toFixed(0)}% of budget used</p>
                    </div>
                  )
                })()}
              </div>
            )}
            <div className="mt-6 flex justify-end"><Button variant="secondary" size="sm" onClick={() => setViewing(null)}>Close</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Revoke confirm — DeletePaymentSession is a hard delete service-side,
          so we gate it behind an explicit confirmation. */}
      <Dialog.Root open={!!revoking} onOpenChange={(o) => { if (!o && !revokeBusy) setRevoking(null) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Revoke session?</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">
              The agent can't spend on this session after revoking, and the record is permanently removed. This can't be undone.
            </Dialog.Description>
            {revoking && (
              <div className="mt-4 rounded-lg bg-surface-2 p-3 text-xs space-y-1.5">
                <div className="flex justify-between gap-4">
                  <span className="text-text-muted">Session ID</span>
                  <span className="font-mono text-right break-all">{revoking.paymentSessionId}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-text-muted">Budget</span>
                  <span className="font-mono">{revoking.limits?.maxSpendAmount?.value} {revoking.limits?.maxSpendAmount?.currency}</span>
                </div>
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setRevoking(null)} disabled={revokeBusy}>Cancel</Button>
              <Button size="sm" onClick={handleRevoke} disabled={revokeBusy}>
                {revokeBusy ? 'Revoking…' : 'Revoke session'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
