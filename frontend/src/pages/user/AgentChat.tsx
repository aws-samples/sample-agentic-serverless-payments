import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useChatStore, useUserStore, useAdminStore } from '@/store'
import { useAuthStore } from '@/store/auth'
import { getAgentWsUrl, createSession as apiCreateSession, getSession as apiGetSession, deleteSession as apiDeleteSession } from '@/lib/api'
import * as Dialog from '@radix-ui/react-dialog'
import { getUsdcBalance, resolveInstrumentContext } from '@/lib/balance'
import { getWalletDetails, getInstrumentVendor } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { VendorBadge } from '@/components/ui/VendorBadge'
import { cn } from '@/lib/utils'
import {
  MessageSquare, Send, Mic, MicOff, RotateCcw, Wallet, Clock, Plus, ChevronDown, RefreshCw, Plug, Unplug, Trash2,
} from 'lucide-react'
import type { AgentMessage, PaymentSession } from '@/types'

// Audio config matching Nova Sonic expectations
const INPUT_SAMPLE_RATE = 16000
const CHUNK_MS = 64

function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim()
}

function ChatBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="flex justify-center py-2">
        <span className="rounded-full bg-surface-3 px-3 py-1 text-[10px] text-text-muted">
          {message.content}
        </span>
      </div>
    )
  }

  const content = isUser ? message.content : stripThinking(message.content)

  return (
    <div className={cn('flex gap-3 max-w-[85%]', isUser ? 'ml-auto flex-row-reverse' : '')}>
      <div className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
        isUser ? 'bg-accent text-white' : 'bg-surface-3 text-text-secondary',
      )}>
        {isUser ? 'U' : 'A'}
      </div>
      <div className={cn(
        'relative rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words overflow-hidden',
        isUser
          ? 'bg-accent text-white rounded-br-md'
          : 'bg-surface-2 text-text-primary border border-border rounded-bl-md',
      )}>
        {message.mediaUrl && message.mediaType === 'image' && (
          <a
            href={message.mediaUrl}
            download={message.mediaTitle ? `${message.mediaTitle.replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 40)}.png` : 'image.png'}
            className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white shadow-md hover:bg-accent/80 transition-colors z-10"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Save
          </a>
        )}
        {content}
        {message.mediaUrl && message.mediaType === 'image' && (
          <div className="mt-2">
            <img
              src={message.mediaUrl}
              alt={message.mediaTitle || 'Generated image'}
              className="rounded-lg border border-border"
              style={{ maxWidth: '100%' }}
              loading="lazy"
            />
            {message.mediaTitle && (
              <p className="mt-1 text-xs text-text-muted">{message.mediaTitle}</p>
            )}
          </div>
        )}
        {message.mediaUrl && message.mediaType === 'audio' && (
          <div className="mt-2">
            <audio controls src={message.mediaUrl} className="w-full">
              <track kind="captions" />
            </audio>
            {message.mediaTitle && (
              <p className="mt-1 text-xs text-text-muted">{message.mediaTitle}</p>
            )}
          </div>
        )}
        {message.isStreaming && (
          <span className="inline-block ml-1 w-1.5 h-4 bg-accent animate-pulse rounded-sm" />
        )}
      </div>
    </div>
  )
}

// ── Session expiry helpers ──

function getLatestSession(sessions: PaymentSession[]): PaymentSession | null {
  if (!sessions.length) return null
  const sorted = [...sessions].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return tb - ta
  })
  return sorted[0]
}

function getSessionForManager(
  sessions: PaymentSession[],
  managerArn: string,
): PaymentSession | null {
  if (!managerArn) return null
  const filtered = sessions.filter((s) => s.paymentManagerArn === managerArn)
  return getLatestSession(filtered)
}

function getSessionExpiry(session: PaymentSession): { expired: boolean; label: string } {
  if (!session.createdAt) return { expired: true, label: 'Unknown' }
  const created = new Date(session.createdAt).getTime()
  // expiryTimeInMinutes from the API — already in minutes (min 15, max 480)
  const expiryMins = session.expiryTimeInMinutes || 15
  const expiryMs = expiryMins * 60 * 1000
  const expiresAt = created + expiryMs
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return { expired: true, label: 'Expired' }
  const mins = Math.floor(remaining / 60000)
  const secs = Math.floor((remaining % 60000) / 1000)
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60)
    const remMins = mins % 60
    return { expired: false, label: `${hrs}h ${remMins}m` }
  }
  return { expired: false, label: `${mins}m ${secs}s` }
}

export function AgentChat() {
  const { messages, wsStatus, isVoiceMode, addMessage, updateMessage, setWsStatus, toggleVoiceMode, clearMessages } = useChatStore()
  const { instruments } = useUserStore()
  const { sessions, addSession, removeSession } = useUserStore()
  const { paymentManagers, paymentConnectors } = useAdminStore()
  const userEmail = useAuthStore((s) => s.email)
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [selectedInstrumentId, setSelectedInstrumentId] = useState('')
  const selectedInstrumentRef = useRef('')
  const [showCreateSession, setShowCreateSession] = useState(false)
  const [sessionBudget, setSessionBudget] = useState('1.0')
  const [sessionExpiryMin, setSessionExpiryMin] = useState('15')
  const [creatingSession, setCreatingSession] = useState(false)
  const [sessionTick, setSessionTick] = useState(0) // forces re-render for countdown
  const [walletBalance, setWalletBalance] = useState<string | null>(null)
  // Full live session record from GetPaymentSession (carries limits +
  // availableLimits). The list summary has neither, so the header reads budget
  // and remaining from this once it loads.
  const [liveSession, setLiveSession] = useState<any | null>(null)
  // Revoke-session confirm state — scopes the target session so the
  // dialog reliably uses the correct manager ARN even if the user picks
  // a different wallet between opening and confirming the revoke.
  const [revokingSession, setRevokingSession] = useState<PaymentSession | null>(null)
  const [revokeSessionBusy, setRevokeSessionBusy] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)

  // Refs for consolidating voice transcripts into single bubbles
  const agentStreamIdRef = useRef<string | null>(null)
  const userStreamIdRef = useRef<string | null>(null)
  const agentAccumRef = useRef('')
  const userAccumRef = useRef('')


  // Ref for current text-streaming message id
  const textStreamIdRef = useRef<string | null>(null)
  // Ref for the single agent bubble that accumulates across response turns
  const textBubbleIdRef = useRef<string | null>(null)
  // Snapshot of completed text turns (finalized text from prior turns)
  const textPriorTurnsRef = useRef('')
  // Current turn's latest cumulative text
  const textCurrentTurnRef = useRef('')
  // Last tool status label shown — guards against consecutive duplicate
  // tool_use events surfacing the same status message twice.
  const lastToolLabelRef = useRef<string | null>(null)
  // Holds the latest refreshLiveSpend so the WS handler can call it after a
  // turn completes without re-creating the handler on every spend change.
  const refreshLiveSpendRef = useRef<() => void>(() => {})
  // Same for the wallet balance — a payment also changes the instrument's
  // on-chain balance, so we re-fetch it after a turn / paid media.
  const refreshBalanceRef = useRef<() => void>(() => {})

  // Debounced refresh for voice mode. Voice (Nova Sonic bidi) emits no
  // `text_done`, and a paid tool's `response_done` can fire BEFORE settlement
  // completes. So we coalesce refresh triggers (agent transcript chunks +
  // response boundaries) into one refresh ~900ms after activity stops, then
  // re-check once more a few seconds later to catch on-chain balance lag.
  const voiceRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleVoiceRefreshRef = useRef<() => void>(() => {
    if (voiceRefreshTimerRef.current) clearTimeout(voiceRefreshTimerRef.current)
    voiceRefreshTimerRef.current = setTimeout(() => {
      refreshLiveSpendRef.current()
      refreshBalanceRef.current()
      // Second pass: session spend updates as soon as ProcessPayment succeeds,
      // but the on-chain instrument balance can take a few seconds to reflect.
      setTimeout(() => {
        refreshLiveSpendRef.current()
        refreshBalanceRef.current()
      }, 3000)
    }, 900)
  })

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  // Clear the debounced voice-refresh timer on unmount.
  useEffect(() => () => { if (voiceRefreshTimerRef.current) clearTimeout(voiceRefreshTimerRef.current) }, [])

  // Auto-select first instrument when none is selected
  useEffect(() => {
    if (!selectedInstrumentId && instruments.length > 0) {
      setSelectedInstrumentId(instruments[0].paymentInstrumentId)
    }
  }, [instruments, selectedInstrumentId])

  // Keep ref in sync for use inside callbacks
  useEffect(() => {
    selectedInstrumentRef.current = selectedInstrumentId
  }, [selectedInstrumentId])

  // Derive the manager ARN for the currently-selected instrument.
  // Sessions are per-manager, so everything downstream scopes off this.
  const selectedManagerArn = useMemo(() => {
    const effectiveId = selectedInstrumentId || instruments[0]?.paymentInstrumentId
    if (!effectiveId) return ''
    const inst = instruments.find((i) => i.paymentInstrumentId === effectiveId)
    const conn = paymentConnectors.find((c) => c.paymentConnectorId === inst?.paymentConnectorId)
    const mgr = paymentManagers.find((m) => m.paymentManagerId === conn?.paymentManagerId)
    return mgr?.paymentManagerArn || ''
  }, [selectedInstrumentId, instruments, paymentConnectors, paymentManagers])

  // Fetch USDC balance via GetPaymentInstrumentBalance when selected instrument changes.
  const refreshBalance = useCallback(() => {
    const effectiveId = selectedInstrumentId || (instruments.length > 0 ? instruments[0].paymentInstrumentId : '')
    if (!effectiveId) { setWalletBalance(null); return }
    const inst = instruments.find((i) => i.paymentInstrumentId === effectiveId)
    if (!inst) { setWalletBalance(null); return }
    const { walletAddress: addr } = getWalletDetails(inst)
    if (!addr) { setWalletBalance(null); return }
    const ctx = resolveInstrumentContext(inst, paymentConnectors, paymentManagers)
    if (!ctx.managerArn || !ctx.connectorId) { setWalletBalance(null); return }
    setWalletBalance(null)
    getUsdcBalance(inst, ctx).then((bal) => setWalletBalance(bal))
  }, [selectedInstrumentId, instruments, paymentConnectors, paymentManagers])

  useEffect(() => { refreshBalanceRef.current = refreshBalance; refreshBalance() }, [refreshBalance])

  // Session countdown ticker (1s interval)
  useEffect(() => {
    const iv = setInterval(() => setSessionTick((t) => t + 1), 1000)
    return () => clearInterval(iv)
  }, [])

  // Fetch the live session from GetPaymentSession for the *current*
  // instrument's manager — sessions are per-manager. Extracted into a callback
  // so we can re-run it after each agent turn (when a payment may have settled)
  // and from a manual refresh button — otherwise spent/remaining go stale the
  // moment the agent buys something mid-conversation.
  //
  // The list summary has no limits/availability, so we store the full live
  // record: limits.maxSpendAmount = budget, availableLimits.availableSpendAmount
  // = remaining. There is no explicit "spent" field; spent = budget − remaining.
  const [spendRefreshing, setSpendRefreshing] = useState(false)
  const refreshLiveSpend = useCallback(async () => {
    const active = getSessionForManager(sessions, selectedManagerArn)
    if (!active) { setLiveSession(null); return }
    setSpendRefreshing(true)
    try {
      const res = await apiGetSession(active.paymentSessionId, active.paymentManagerArn)
      setLiveSession(res.paymentSession ?? res)
    } catch {
      setLiveSession(null)
    } finally {
      setSpendRefreshing(false)
    }
  }, [sessions, selectedManagerArn])

  // Keep the ref pointed at the latest callback for the WS handler to call.
  useEffect(() => { refreshLiveSpendRef.current = refreshLiveSpend }, [refreshLiveSpend])

  useEffect(() => {
    let cancelled = false
    const active = getSessionForManager(sessions, selectedManagerArn)
    if (!active) { setLiveSession(null); return }
    apiGetSession(active.paymentSessionId, active.paymentManagerArn)
      .then((res) => {
        if (cancelled) return
        setLiveSession(res.paymentSession ?? res)
      })
      .catch(() => { if (!cancelled) setLiveSession(null) })
    return () => { cancelled = true }
  }, [sessions, selectedManagerArn, instruments])

  // Cleanup on unmount only — no auto-connect so user can pick wallet first
  useEffect(() => {
    return () => {
      stopVoice()
      wsRef.current?.close(1000)
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push a context_update frame to the agent whenever the user's wallet
  // or session state changes mid-connection. The backend re-binds the
  // tools' payment credentials without requiring a reconnect, so paid
  // tools pick up newly-created sessions immediately.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (wsStatus !== 'connected') return
    const instId = selectedInstrumentId || instruments[0]?.paymentInstrumentId
    if (!instId) return
    const inst = instruments.find((i) => i.paymentInstrumentId === instId)
    if (!inst) return
    const { walletAddress, network } = getWalletDetails(inst)
    const connector = paymentConnectors.find((c) => c.paymentConnectorId === inst.paymentConnectorId)
    const manager = paymentManagers.find((m) => m.paymentManagerId === connector?.paymentManagerId)
    const managerArn = manager?.paymentManagerArn || inst.paymentManagerArn || ''
    const activeForManager = managerArn ? getSessionForManager(sessions, managerArn) : null
    try {
      ws.send(JSON.stringify({
        type: 'context_update',
        instrumentId: inst.paymentInstrumentId,
        walletAddress,
        network,
        connectorId: inst.paymentConnectorId,
        managerArn,
        sessionId: activeForManager?.paymentSessionId || '',
      }))
    } catch {
      // WS may have closed between readyState check and send — ignore.
    }
  }, [
    wsStatus,
    selectedInstrumentId,
    instruments,
    sessions,
    paymentConnectors,
    paymentManagers,
  ])

  // ── Shared WS message handler (used by both voice and text modes) ──

  const handleWsMessage = useCallback((event: MessageEvent) => {
    if (typeof event.data === 'string') {
      try {
        const data = JSON.parse(event.data)

        if (data.type === 'status' && data.status === 'ready') {
          // Handled by connectWs promise
          return
        }

        // Agent confirmation that a mid-connection context_update landed.
        // Purely informational — the effect that sent it already reflects
        // the state we wanted bound, so nothing to do here.
        if (data.type === 'context_ack') {
          return
        }

        // Voice mode status events (reconnecting, tool executing)
        if (data.type === 'status' && data.status === 'reconnecting') {
          addMessage({ id: crypto.randomUUID(), role: 'system', content: 'Reconnecting\u2026', timestamp: Date.now() })
          return
        }
        if (data.type === 'status' && data.status === 'tool_executing') {
          // Tool is running in background — no need for a separate message,
          // the tool_use event already shows which tool
          return
        }
        if (data.type === 'status' && data.status === 'thinking') {
          // Keepalive ping during Agent init — ignore silently
          return
        }

        // Voice transcript events
        if (data.type === 'text' && data.content && data.role) {
          const isUserTranscript = data.role.toUpperCase() === 'USER'
          const isFinal = data.is_final !== false

          if (isUserTranscript) {
            // Any user speech finalizes the current agent bubble and resets for next exchange
            if (agentStreamIdRef.current) {
              updateMessage(agentStreamIdRef.current, agentAccumRef.current, false)
              agentStreamIdRef.current = null
              agentAccumRef.current = ''
            }

            if (isFinal) {
              if (userStreamIdRef.current) {
                updateMessage(userStreamIdRef.current, data.content, false)
                userStreamIdRef.current = null
                userAccumRef.current = ''
              } else {
                addMessage({ id: crypto.randomUUID(), role: 'user', content: data.content, timestamp: Date.now() })
              }
            } else {
              userAccumRef.current = data.content
              if (!userStreamIdRef.current) {
                const uid = crypto.randomUUID()
                userStreamIdRef.current = uid
                addMessage({ id: uid, role: 'user', content: data.content, timestamp: Date.now(), isStreaming: true })
              } else {
                updateMessage(userStreamIdRef.current, data.content)
              }
            }
          } else {
            // Agent transcript — incremental sentence chunks.
            // Nova Sonic sends each chunk twice: first with is_final=false (streaming),
            // then replays all chunks with is_final=true (confirmation).
            // We only need the first pass — skip the is_final=true replay entirely.
            if (isFinal) {
              // The agent's final spoken transcript reliably lands AFTER any
              // paid tool (buy/refund) has executed, so this is the safest
              // post-settlement signal in voice. Debounced so the replayed
              // chunks coalesce into a single refresh.
              scheduleVoiceRefreshRef.current()
              return
            }

            if (userStreamIdRef.current) {
              updateMessage(userStreamIdRef.current, userAccumRef.current)
              userStreamIdRef.current = null
              userAccumRef.current = ''
            }

            // Append this chunk to the running agent text
            agentAccumRef.current = agentAccumRef.current
              ? agentAccumRef.current + data.content
              : data.content

            if (!agentStreamIdRef.current) {
              const aid = crypto.randomUUID()
              agentStreamIdRef.current = aid
              addMessage({ id: aid, role: 'agent', content: agentAccumRef.current, timestamp: Date.now(), isStreaming: true })
            } else {
              updateMessage(agentStreamIdRef.current, agentAccumRef.current, true)
            }
          }
          return
        }

        // Text streaming events (from converse_text_streaming)
        // Backend sends cumulative text per turn. Across turns (different data.id),
        // we append so all agent text accumulates paragraph-style in one bubble.
        if (data.type === 'text_stream' && data.id && data.content !== undefined) {
          const clean = stripThinking(data.content)

          if (textStreamIdRef.current !== data.id) {
            // New response turn — snapshot the previous turn's final text
            if (textCurrentTurnRef.current) {
              textPriorTurnsRef.current = textPriorTurnsRef.current
                ? textPriorTurnsRef.current + '\n\n' + textCurrentTurnRef.current
                : textCurrentTurnRef.current
            }
            textStreamIdRef.current = data.id
          }

          // Current turn's cumulative text
          textCurrentTurnRef.current = clean
          // Full display: prior turns + current turn
          const display = textPriorTurnsRef.current
            ? textPriorTurnsRef.current + '\n\n' + clean
            : clean

          if (!textBubbleIdRef.current) {
            const bid = crypto.randomUUID()
            textBubbleIdRef.current = bid
            addMessage({ id: bid, role: 'agent', content: display, timestamp: Date.now(), isStreaming: true })
          } else {
            updateMessage(textBubbleIdRef.current, display, true)
          }
          return
        }

        if (data.type === 'text_done' && data.id) {
          const clean = stripThinking(data.content || '')
          // Finalize this turn's text
          textCurrentTurnRef.current = clean
          const display = textPriorTurnsRef.current
            ? textPriorTurnsRef.current + '\n\n' + clean
            : clean

          // Snapshot this turn into prior turns for potential next turn
          textPriorTurnsRef.current = display
          textCurrentTurnRef.current = ''

          if (textBubbleIdRef.current) {
            updateMessage(textBubbleIdRef.current, display, false)
          } else {
            addMessage({ id: data.id, role: 'agent', content: display, timestamp: Date.now() })
          }
          textStreamIdRef.current = null
          setIsSending(false)
          // A payment may have settled during this turn — refresh live spend
          // and the wallet balance so the header reflects it immediately.
          refreshLiveSpendRef.current()
          refreshBalanceRef.current()
          return
        }

        if (data.type === 'tool_use') {
          const rawName: string = data.name || ''
          // Map raw tool ids to human-readable, present-tense status labels.
          const TOOL_LABELS: Record<string, string> = {
            strands_generate_image: 'Generating image',
            generate_image: 'Generating image',
            check_balance: 'Checking balance',
            strands_check_balance: 'Checking balance',
            list_products: 'Browsing storefront',
            strands_list_products: 'Browsing storefront',
            buy_product: 'Processing purchase',
            strands_buy_product: 'Processing purchase',
            list_orders: 'Looking up your orders',
            strands_list_orders: 'Looking up your orders',
            cancel_order: 'Processing refund',
            strands_cancel_order: 'Processing refund',
          }
          const label = TOOL_LABELS[rawName]
            || (rawName ? rawName.replace(/^strands_/, '').replace(/_/g, ' ') : 'Working')

          // Defensive dedup: ignore a repeated label identical to the last
          // tool status already shown (the backend dedupes per toolUseId, this
          // guards against any residual repeats).
          if (lastToolLabelRef.current === label) {
            return
          }
          lastToolLabelRef.current = label

          addMessage({
            id: crypto.randomUUID(), role: 'system',
            content: `${label}\u2026`,
            timestamp: Date.now(),
          })
          return
        }

        // Media delivery (presigned URL from S3)
        if (data.type === 'media' && data.url) {
          addMessage({
            id: crypto.randomUUID(),
            role: 'agent',
            content: data.title ? data.title : 'Media delivered',
            timestamp: Date.now(),
            mediaUrl: data.url,
            mediaType: data.mediaType || 'image',
            mediaTitle: data.title || '',
          })
          // Media delivery is a paid action (e.g. image generation) — refresh
          // live spend and balance so the header reflects it (covers voice,
          // where a turn may not emit text_done).
          refreshLiveSpendRef.current()
          refreshBalanceRef.current()
          return
        }

        // Response boundary — keep agent bubble alive for next turn to append
        if (data.type === 'response_done') {
          if (userStreamIdRef.current) {
            updateMessage(userStreamIdRef.current, userAccumRef.current, false)
            userStreamIdRef.current = null
            userAccumRef.current = ''
          }
          // Voice mode emits no `text_done`. A purchase/refund may still be
          // settling at this boundary, so use the debounced voice refresh
          // (which also re-checks a few seconds later for balance lag) rather
          // than a single immediate refetch.
          scheduleVoiceRefreshRef.current()
          // Reset for next turn
          return
        }

        if (data.type === 'error') {
          addMessage({
            id: crypto.randomUUID(), role: 'system',
            content: `Error: ${data.content || 'unknown'}`,
            timestamp: Date.now(),
          })
          setIsSending(false)
          return
        }
      } catch {
        addMessage({ id: crypto.randomUUID(), role: 'agent', content: event.data, timestamp: Date.now() })
      }
    } else if (event.data instanceof Blob) {
      playAudioBlob(event.data)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMessage, updateMessage])

  // ── Shared WS connect (used by both voice and text modes) ──

  const connectWs = useCallback(async (mode: 'voice' | 'text'): Promise<WebSocket> => {
    const { wsUrl, userId } = await getAgentWsUrl()
    return new Promise<WebSocket>((resolve, reject) => {
      let resolved = false
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        const instId = selectedInstrumentRef.current || undefined
        const inst = instruments.find((i) => i.paymentInstrumentId === instId)
        const walletDetails = inst ? getWalletDetails(inst) : { walletAddress: undefined, network: undefined }
        const walletAddr = walletDetails.walletAddress
        const network = walletDetails.network

        // Resolve the extra fields the agent needs at connect time so
        // tools (check_balance, generate_image, buy_product, cancel_order) and the
        // optional AgentCorePaymentsPlugin have the full payment context
        // without the agent having to hit any database.
        const connector = paymentConnectors.find(
          (c) => c.paymentConnectorId === inst?.paymentConnectorId,
        )
        const manager = paymentManagers.find(
          (m) => m.paymentManagerId === connector?.paymentManagerId,
        )
        const managerArn = manager?.paymentManagerArn || inst?.paymentManagerArn || undefined
        const connectorId = inst?.paymentConnectorId || undefined
        const activeForManager = managerArn ? getSessionForManager(sessions, managerArn) : null
        const sessionId = activeForManager?.paymentSessionId || undefined

        // Payments are scoped to the authenticated user's Cognito sub
        // (sent as `userId`) — the same identity instruments and sessions
        // were created under.
        ws.send(JSON.stringify({
          type: 'init',
          userId,
          mode,
          instrumentId: instId,
          walletAddress: walletAddr,
          network,
          connectorId,
          managerArn,
          sessionId,
          email: userEmail || undefined,
        }))
      }

      ws.onmessage = (event) => {
        if (!resolved && typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'status' && data.status === 'ready') {
              resolved = true
              setWsStatus('connected')
              resolve(ws)
              return
            }
          } catch { /* ignore */ }
        }
        handleWsMessage(event)
      }

      ws.onclose = (e) => {
        setWsStatus('disconnected')
        wsRef.current = null
        stopMicCapture()
        if (!resolved) {
          resolved = true
          reject(new Error(`WebSocket closed before ready (code ${e.code})`))
        } else if (e.code !== 1000) {
          addMessage({ id: crypto.randomUUID(), role: 'system', content: `Disconnected (code ${e.code})`, timestamp: Date.now() })
        }
      }

      ws.onerror = () => {
        setWsStatus('error')
        if (!resolved) {
          resolved = true
          reject(new Error('WebSocket connection error'))
        }
        addMessage({ id: crypto.randomUUID(), role: 'system', content: 'Connection error', timestamp: Date.now() })
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setWsStatus, addMessage, handleWsMessage, userEmail])

  // ── Voice: mic capture ──

  const startMicCapture = useCallback((ws: WebSocket) => {
    navigator.mediaDevices.getUserMedia({ audio: { sampleRate: INPUT_SAMPLE_RATE, channelCount: 1, echoCancellation: true } })
      .then((stream) => {
        mediaStreamRef.current = stream
        const audioCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
        audioContextRef.current = audioCtx
        const source = audioCtx.createMediaStreamSource(stream)

        const bufferSize = Math.round(INPUT_SAMPLE_RATE * CHUNK_MS / 1000)
        const pow2 = Math.pow(2, Math.ceil(Math.log2(bufferSize)))
        const processor = audioCtx.createScriptProcessor(pow2, 1, 1)
        processorRef.current = processor

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return
          const float32 = e.inputBuffer.getChannelData(0)
          const int16 = new Int16Array(float32.length)
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]))
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
          }
          ws.send(int16.buffer)
        }

        source.connect(processor)
        processor.connect(audioCtx.destination)
      })
      .catch((err) => {
        addMessage({
          id: crypto.randomUUID(), role: 'system',
          content: `Mic access denied: ${err instanceof Error ? err.message : 'unknown'}`,
          timestamp: Date.now(),
        })
      })
  }, [addMessage])

  const stopMicCapture = useCallback(() => {
    processorRef.current?.disconnect()
    processorRef.current = null
    audioContextRef.current?.close()
    audioContextRef.current = null
    mediaStreamRef.current?.getTracks().forEach(t => t.stop())
    mediaStreamRef.current = null
  }, [])

  // ── Queued audio playback ──

  const playbackCtxRef = useRef<AudioContext | null>(null)
  const audioQueueRef = useRef<AudioBuffer[]>([])
  const isPlayingRef = useRef(false)
  const nextPlayTimeRef = useRef(0)

  const playNextInQueue = useCallback(() => {
    const ctx = playbackCtxRef.current
    if (!ctx || audioQueueRef.current.length === 0) {
      isPlayingRef.current = false
      return
    }
    isPlayingRef.current = true
    const buffer = audioQueueRef.current.shift()!
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    const now = ctx.currentTime
    const startAt = Math.max(now, nextPlayTimeRef.current)
    nextPlayTimeRef.current = startAt + buffer.duration
    source.start(startAt)
    source.onended = () => playNextInQueue()
  }, [])

  const playAudioBlob = useCallback(async (blob: Blob) => {
    try {
      // Nova Sonic via Strands BidiNovaSonicModel outputs 16kHz PCM
      const OUTPUT_SAMPLE_RATE = 16000
      if (!playbackCtxRef.current) {
        playbackCtxRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
      }
      const ctx = playbackCtxRef.current
      const arrayBuf = await blob.arrayBuffer()
      const int16 = new Int16Array(arrayBuf)
      const float32 = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768
      }
      const audioBuffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE)
      audioBuffer.getChannelData(0).set(float32)

      audioQueueRef.current.push(audioBuffer)
      if (!isPlayingRef.current) {
        playNextInQueue()
      }
    } catch (err) {
      console.warn('Audio playback error:', err)
    }
  }, [playNextInQueue])

  // ── Voice start / stop ──

  const startVoice = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    setWsStatus('connecting')
    try {
      addMessage({ id: crypto.randomUUID(), role: 'system', content: 'Connecting voice\u2026', timestamp: Date.now() })
      const ws = await connectWs('voice')
      addMessage({ id: crypto.randomUUID(), role: 'system', content: '\uD83C\uDF99\uFE0F Voice connected \u2014 speak now', timestamp: Date.now() })
      startMicCapture(ws)
    } catch (err) {
      setWsStatus('error')
      addMessage({
        id: crypto.randomUUID(), role: 'system',
        content: `Failed to connect: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      })
    }
  }, [setWsStatus, addMessage, connectWs, startMicCapture])

  const stopVoice = useCallback(() => {
    stopMicCapture()
    wsRef.current?.close(1000)
    wsRef.current = null
    audioQueueRef.current = []
    isPlayingRef.current = false
    nextPlayTimeRef.current = 0
    playbackCtxRef.current?.close()
    playbackCtxRef.current = null
    agentStreamIdRef.current = null
    userStreamIdRef.current = null
    agentAccumRef.current = ''
    userAccumRef.current = ''
  }, [stopMicCapture])

  const handleVoiceToggle = useCallback(() => {
    if (isVoiceMode) {
      stopVoice()
      toggleVoiceMode()
      setWsStatus('disconnected')
    } else {
      // Close text WS before opening voice WS
      wsRef.current?.close(1000)
      wsRef.current = null
      toggleVoiceMode()
      startVoice()
    }
  }, [isVoiceMode, stopVoice, toggleVoiceMode, startVoice, setWsStatus])

  // ── New Chat (disconnect, clear, reconnect in prior mode) ──

  const handleNewChat = useCallback(async () => {
    const wasConnected = wsRef.current?.readyState === WebSocket.OPEN
    const wasVoice = isVoiceMode

    // Disconnect current mode
    if (wasVoice) {
      stopVoice()
    } else {
      wsRef.current?.close(1000)
      wsRef.current = null
    }
    setWsStatus('disconnected')

    // Clear messages
    clearMessages()

    // Reconnect in the same mode if it was connected
    if (wasConnected) {
      if (wasVoice) {
        startVoice()
      } else {
        try {
          setWsStatus('connecting')
          await connectWs('text')
          addMessage({ id: crypto.randomUUID(), role: 'system', content: 'New chat started', timestamp: Date.now() })
        } catch {
          setWsStatus('disconnected')
        }
      }
    }
  }, [isVoiceMode, stopVoice, clearMessages, setWsStatus, startVoice, connectWs, addMessage])

  // ── Text connect / disconnect ──

  const connectText = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    setWsStatus('connecting')
    try {
      await connectWs('text')
      addMessage({ id: crypto.randomUUID(), role: 'system', content: 'Text mode connected', timestamp: Date.now() })
    } catch (err) {
      setWsStatus('error')
      addMessage({
        id: crypto.randomUUID(), role: 'system',
        content: `Failed to connect: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      })
    }
  }, [setWsStatus, connectWs, addMessage])

  const disconnectText = useCallback(() => {
    wsRef.current?.close(1000)
    wsRef.current = null
    setWsStatus('disconnected')
    addMessage({ id: crypto.randomUUID(), role: 'system', content: 'Disconnected', timestamp: Date.now() })
  }, [setWsStatus, addMessage])

  // ── Text send via WebSocket (streaming) ──

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || isSending) return

    addMessage({ id: crypto.randomUUID(), role: 'user', content: text, timestamp: Date.now() })
    setInput('')
    inputRef.current?.focus()
    setIsSending(true)

    // Reset text accumulation so the agent's reply starts a fresh bubble
    textBubbleIdRef.current = null
    textPriorTurnsRef.current = ''
    textCurrentTurnRef.current = ''
    textStreamIdRef.current = null
    lastToolLabelRef.current = null

    try {
      // Connect if not already connected
      let ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        addMessage({ id: crypto.randomUUID(), role: 'system', content: 'Connecting…', timestamp: Date.now() })
        ws = await connectWs('text')
      }
      ws.send(JSON.stringify({ type: 'text', content: text, instrumentId: selectedInstrumentRef.current || undefined }))
    } catch (err) {
      addMessage({
        id: crypto.randomUUID(), role: 'system',
        content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      })
      setIsSending(false)
    }
  }, [input, isSending, addMessage, connectWs])

  // ── Quick create session ──

  const handleCreateSession = useCallback(async () => {
    // Prefer the manager tied to the selected instrument so the session
    // authorizes payments for that wallet. Fall back to paymentManagers[0]
    // only when there are no instruments yet (first-time setup).
    const managerArn = selectedManagerArn || paymentManagers[0]?.paymentManagerArn
    if (!managerArn) return
    setCreatingSession(true)
    try {
      const res = await apiCreateSession({
        paymentManagerArn: managerArn,
        maxSpendAmount: { value: sessionBudget, currency: 'USD' },
        expiryTimeInMinutes: parseInt(sessionExpiryMin, 10) || 15,
      })
      const created = res.paymentSession ?? res
      // Defensive fallback — response should already carry expiryTimeInMinutes.
      if (!created.expiryTimeInMinutes) {
        created.expiryTimeInMinutes = parseInt(sessionExpiryMin, 10) || 15
      }
      addSession(created)
      setShowCreateSession(false)
      addMessage({ id: crypto.randomUUID(), role: 'system', content: `Session created (budget: ${sessionBudget} USD, expires in ${sessionExpiryMin}m)`, timestamp: Date.now() })
    } catch (err) {
      addMessage({ id: crypto.randomUUID(), role: 'system', content: `Session error: ${err instanceof Error ? err.message : 'unknown'}`, timestamp: Date.now() })
    } finally {
      setCreatingSession(false)
    }
  }, [selectedManagerArn, paymentManagers, sessionBudget, sessionExpiryMin, addSession, addMessage])

  // Revoke the active session. Hard delete service-side, matches the
  // Sessions page flow but inline in the chat header so users can kill a
  // session without leaving the conversation.
  const handleRevokeSession = useCallback(async () => {
    if (!revokingSession) return
    setRevokeSessionBusy(true)
    try {
      await apiDeleteSession(revokingSession.paymentSessionId, {
        managerArn: revokingSession.paymentManagerArn,
      })
      removeSession(revokingSession.paymentSessionId)
      addMessage({
        id: crypto.randomUUID(),
        role: 'system',
        content: 'Payment session revoked. Create a new one to keep paying.',
        timestamp: Date.now(),
      })
      setRevokingSession(null)
    } catch (err) {
      addMessage({
        id: crypto.randomUUID(),
        role: 'system',
        content: `Failed to revoke session: ${err instanceof Error ? err.message : 'unknown'}`,
        timestamp: Date.now(),
      })
    } finally {
      setRevokeSessionBusy(false)
    }
  }, [revokingSession, removeSession, addMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // Derived session info — scoped to the selected instrument's manager.
  // If the user switches to an instrument on a different manager, this
  // naturally pivots to that manager's latest session (or null if none).
  const activeSession = getSessionForManager(sessions, selectedManagerArn)
  const sessionExpiry = activeSession ? getSessionExpiry(activeSession) : null
  // True when there are sessions but none for the selected instrument's
  // manager. Used to warn the user before they try to chat.
  const sessionMismatch = !activeSession && sessions.length > 0 && !!selectedManagerArn
  // Force re-read on tick
  void sessionTick

  // Truncate helpers
  const truncId = (id: string) => id.length > 12 ? id.slice(0, 6) + '…' + id.slice(-4) : id
  const truncAddr = (addr: string) => addr.length > 12 ? addr.slice(0, 6) + '…' + addr.slice(-4) : addr

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="shrink-0">
          <h1 className="text-lg font-bold text-text-primary">Agent Chat</h1>
          <p className="text-xs text-text-muted">
            {isVoiceMode
              ? wsStatus === 'connected' ? '\uD83C\uDF99\uFE0F Voice active' : wsStatus === 'connecting' ? 'Connecting\u2026' : 'Voice off'
              : wsStatus === 'connected' ? 'Text mode \u2014 connected' : wsStatus === 'connecting' ? 'Connecting\u2026' : 'Select wallet & connect'}
          </p>
        </div>
        {/* Centered instrument selector + balance */}
        {instruments.length > 0 && (
          <div className="flex flex-col items-center gap-0.5">
            <div className="relative flex items-center gap-1.5">
              <select
                value={selectedInstrumentId}
                onChange={(e) => setSelectedInstrumentId(e.target.value)}
                className="h-8 appearance-none rounded-lg border border-border bg-surface-2 pl-3 pr-7 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50 cursor-pointer"
              >
                {instruments.map((inst) => {
                  const { network: net, walletAddress: addr } = getWalletDetails(inst)
                  const vend = getInstrumentVendor(inst, paymentConnectors)
                  const label = vend === 'CoinbaseCDP' ? 'Coinbase' : vend === 'StripePrivy' ? 'Stripe' : ''
                  return (
                    <option key={inst.paymentInstrumentId} value={inst.paymentInstrumentId}>
                      {label ? `[${label}] ` : ''}{net} · {truncAddr(addr || '')}
                    </option>
                  )
                })}
              </select>
              <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-muted" />
              {(() => {
                const sel = instruments.find((i) => i.paymentInstrumentId === selectedInstrumentId)
                const vend = sel ? getInstrumentVendor(sel, paymentConnectors) : null
                return vend ? <VendorBadge vendor={vend} size="sm" /> : null
              })()}
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <Wallet size={12} className="text-accent" />
              {walletBalance === null ? (
                <span className="animate-pulse text-text-muted">loading…</span>
              ) : (
                <span className="font-semibold tabular-nums text-text-primary">{walletBalance} <span className="text-text-muted font-normal">USDC</span></span>
              )}
              <button onClick={refreshBalance} className="text-text-muted hover:text-accent transition-colors" aria-label="Refresh balance">
                <RefreshCw size={11} />
              </button>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 shrink-0">
          {!isVoiceMode && wsStatus !== 'connected' && (
            <Button
              variant="primary"
              size="sm"
              onClick={connectText}
              disabled={wsStatus === 'connecting'}
              icon={<Plug size={14} />}
            >
              {wsStatus === 'connecting' ? 'Connecting…' : 'Text'}
            </Button>
          )}
          {!isVoiceMode && wsStatus === 'connected' && (
            <Button
              variant="danger"
              size="sm"
              onClick={disconnectText}
              icon={<Unplug size={14} />}
            >
              Stop Text
            </Button>
          )}
          <Button
            variant={isVoiceMode ? 'danger' : 'secondary'}
            size="sm"
            onClick={handleVoiceToggle}
            disabled={wsStatus === 'connecting' || (!isVoiceMode && wsStatus === 'connected')}
            icon={isVoiceMode ? <MicOff size={14} /> : <Mic size={14} />}
          >
            {isVoiceMode ? 'Stop Voice' : 'Voice'}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleNewChat} icon={<RotateCcw size={14} />}>
            New Chat
          </Button>
        </div>
      </div>

      {/* Session status bar */}
      <div className="flex items-center gap-3 border-b border-border py-2 px-1 text-xs">
        {activeSession ? (
          <>
            <Clock size={12} className="text-text-muted shrink-0" />
            <span className="text-text-secondary">
              Session {truncId(activeSession.paymentSessionId)}
            </span>
            <span className="text-text-muted">·</span>
            <span className="inline-flex items-center gap-1">
              {(() => {
                // Budget comes from the live record (the list summary has no
                // limits); fall back to the stored row if present.
                const b = (liveSession?.limits?.maxSpendAmount) || activeSession.limits?.maxSpendAmount
                return (
                  <>
                    <span className="text-sm font-semibold text-text-primary tabular-nums">{b?.value || '?'}</span>
                    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-mono uppercase text-text-muted">{b?.currency || 'USD'}</span>
                  </>
                )
              })()}
            </span>
            {(() => {
              // budget from live record; remaining from availableSpendAmount;
              // spent = budget − remaining. No explicit spent field exists.
              const budget = parseFloat(liveSession?.limits?.maxSpendAmount?.value ?? activeSession.limits?.maxSpendAmount?.value ?? '') || 0
              const availRaw = liveSession?.availableLimits?.availableSpendAmount?.value
              if (!budget || availRaw == null) return null
              const currency = liveSession?.limits?.maxSpendAmount?.currency || activeSession.limits?.maxSpendAmount?.currency || 'USD'
              const remaining = Math.max(0, parseFloat(availRaw) || 0)
              const spent = Math.max(0, budget - remaining)
              const low = remaining <= budget * 0.1
              return (
                <>
                  <span className="text-text-muted">·</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-[10px] text-text-muted">spent</span>
                    <span className="text-xs font-semibold tabular-nums text-amber-400">{spent.toFixed(2)} {currency}</span>
                  </span>
                  <span className="text-text-muted">·</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-[10px] text-text-muted">left</span>
                    <span className={`text-xs font-semibold tabular-nums ${low ? 'text-red-400' : 'text-green-400'}`}>
                      {remaining.toFixed(2)} {currency}
                    </span>
                  </span>
                </>
              )
            })()}
            <span className="text-text-muted">·</span>
            <span className={sessionExpiry?.expired ? 'text-red-400' : 'text-green-400'}>
              {sessionExpiry?.label}
            </span>
            <button
              type="button"
              aria-label="Refresh session spend"
              title="Refresh spend / remaining"
              onClick={() => refreshLiveSpend()}
              className="text-text-muted hover:text-text-secondary disabled:opacity-50"
              disabled={spendRefreshing}
            >
              <RefreshCw size={11} className={spendRefreshing ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => setRevokingSession(activeSession)}
              className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-danger-muted hover:text-danger transition-colors"
              title="Revoke this session (permanent)"
              aria-label="Revoke session"
            >
              <Trash2 size={10} />
              Revoke
            </button>
          </>
        ) : sessionMismatch ? (
          <span className="text-amber-400">Selected wallet uses a different payment manager — create a new session for it</span>
        ) : (
          <span className="text-text-muted">No active session</span>
        )}
        <div className="ml-auto">
          {showCreateSession ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.1"
                min="0.01"
                value={sessionBudget}
                onChange={(e) => setSessionBudget(e.target.value)}
                className="h-6 w-16 rounded border border-border bg-surface-2 px-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="USD"
              />
              <input
                type="number"
                min="15"
                max="480"
                value={sessionExpiryMin}
                onChange={(e) => setSessionExpiryMin(e.target.value)}
                className="h-6 w-14 rounded border border-border bg-surface-2 px-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="min"
              />
              <span className="text-[10px] text-text-muted">min</span>
              <button
                onClick={handleCreateSession}
                disabled={creatingSession || !paymentManagers.length}
                className="rounded bg-accent px-2 py-0.5 text-xs text-white hover:bg-accent/80 disabled:opacity-40"
              >
                {creatingSession ? '…' : 'Create'}
              </button>
              <button
                onClick={() => setShowCreateSession(false)}
                className="text-text-muted hover:text-text-primary text-xs"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowCreateSession(true)}
              className="flex items-center gap-1 rounded bg-surface-3 px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-2"
            >
              <Plus size={10} /> New Payment Session
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="rounded-2xl bg-surface-2 p-6 mb-4">
              <MessageSquare size={32} className="text-text-muted" />
            </div>
            <p className="text-sm font-medium text-text-primary">Ready to chat</p>
            <p className="text-xs text-text-muted mt-1 max-w-xs">
              Select your wallet above, then click Connect or just type a message to start.
            </p>
          </div>
        ) : (
          messages.map((msg) => <ChatBubble key={msg.id} message={msg} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Voice Mode Indicator */}
      {isVoiceMode && wsStatus === 'connected' && (
        <div className="flex items-center justify-center gap-3 py-3 border-t border-border bg-surface-1">
          <div className="flex items-center gap-1.5">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="w-1 rounded-full bg-accent animate-pulse"
                style={{ height: `${12 + Math.random() * 16}px`, animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
          <span className="text-xs text-text-muted">Listening\u2026</span>
          <Button variant="danger" size="sm" onClick={handleVoiceToggle} icon={<MicOff size={14} />}>
            Stop
          </Button>
        </div>
      )}

      {/* Text Input */}
      {!isVoiceMode && (
        <div className="border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isSending ? 'Waiting for response\u2026' : 'Type a message\u2026'}
              disabled={isSending}
              className={cn(
                'flex-1 h-10 rounded-xl border border-border bg-surface-2 px-4 text-sm text-text-primary',
                'placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            />
            <Button
              size="lg"
              onClick={sendMessage}
              disabled={!input.trim() || isSending}
              icon={<Send size={16} />}
              className="rounded-xl"
            >
              {isSending ? '\u2026' : 'Send'}
            </Button>
          </div>
        </div>
      )}

      {/* Revoke-session confirm — hard delete service-side, so we gate it
          behind explicit confirmation even inline in the chat. */}
      <Dialog.Root open={!!revokingSession} onOpenChange={(o) => { if (!o && !revokeSessionBusy) setRevokingSession(null) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
            <Dialog.Title className="text-base font-semibold text-text-primary">Revoke session?</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-text-muted">
              The agent can't spend on this session after revoking, and the record is permanently removed. This can't be undone.
            </Dialog.Description>
            {revokingSession && (
              <div className="mt-4 rounded-lg bg-surface-2 p-3 text-xs space-y-1.5">
                <div className="flex justify-between gap-4">
                  <span className="text-text-muted">Session ID</span>
                  <span className="font-mono text-right break-all">{revokingSession.paymentSessionId}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-text-muted">Budget</span>
                  <span className="font-mono">{revokingSession.limits?.maxSpendAmount?.value} {revokingSession.limits?.maxSpendAmount?.currency}</span>
                </div>
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setRevokingSession(null)} disabled={revokeSessionBusy}>Cancel</Button>
              <Button size="sm" onClick={handleRevokeSession} disabled={revokeSessionBusy}>
                {revokeSessionBusy ? 'Revoking…' : 'Revoke session'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
