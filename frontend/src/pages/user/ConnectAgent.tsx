/**
 * Connect Agent — Privy session-signer attach page.
 *
 * AgentCore creates Privy-backed wallets server-side (keyed by the user's
 * email), but the agent can only sign x402 payments once the AgentCore
 * authorization-key quorum is attached as a session signer on each wallet.
 * That attach step is a one-time, per-wallet user action.
 *
 * This page ports the "Give access" flow from the Privy + AWS reference
 * frontend (privy-io/aws-agentcore-sdk → connect-agent-modal.tsx). The user
 * signs into Privy with the email that owns the wallets, then grants the
 * agent access by calling `addSessionSigners` across every Privy wallet on
 * the account. `addSessionSigners` is idempotent — Privy reports "already
 * exists" for wallets that are already covered, which we treat as success.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  usePrivy,
  useSessionSigners,
  useLoginWithEmail,
  type LinkedAccountWithMetadata,
  type WalletWithMetadata,
} from '@privy-io/react-auth'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useAuthStore } from '@/store/auth'
import { Info, ShieldCheck, ArrowLeft, Mail } from 'lucide-react'

const PRIVY_SIGNER_ID = import.meta.env.VITE_PRIVY_SIGNER_ID as string | undefined

export function ConnectAgent() {
  const navigate = useNavigate()
  const { email: userEmail } = useAuthStore()
  const { user, authenticated: isPrivyAuthenticated } = usePrivy()
  const { addSessionSigners } = useSessionSigners()
  const { sendCode, loginWithCode } = useLoginWithEmail()

  // Email OTP state — only used when the user isn't signed into Privy yet.
  const [otpEmail, setOtpEmail] = useState(userEmail || '')
  const [otpSent, setOtpSent] = useState(false)
  const [otpCode, setOtpCode] = useState('')
  const [otpSending, setOtpSending] = useState(false)
  const [otpVerifying, setOtpVerifying] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  // Privy embedded wallets on the signed-in account.
  const privyWallets = (
    user?.linkedAccounts ?? ([] as LinkedAccountWithMetadata[])
  ).filter(
    (a: LinkedAccountWithMetadata): a is WalletWithMetadata =>
      a.type === 'wallet' && (a as WalletWithMetadata).walletClientType === 'privy',
  )

  const handleSendOtp = async () => {
    setOtpSending(true); setError('')
    try {
      await sendCode({ email: otpEmail })
      setOtpSent(true)
    } catch (err: any) {
      setError(err?.message || 'Failed to send verification code')
    } finally {
      setOtpSending(false)
    }
  }

  const handleVerifyOtp = async () => {
    setOtpVerifying(true); setError('')
    try {
      await loginWithCode({ code: otpCode })
      // Privy session is now active; the wallet list resolves on re-render.
    } catch (err: any) {
      setError(err?.message || 'Invalid verification code')
    } finally {
      setOtpVerifying(false)
    }
  }

  const handleGiveAccess = async () => {
    if (!PRIVY_SIGNER_ID) {
      setError('Signer ID is not configured (VITE_PRIVY_SIGNER_ID).')
      return
    }
    if (privyWallets.length === 0) {
      setError('No Privy wallets found on this account. Create a Privy instrument first, then return here.')
      return
    }

    setBusy(true); setError('')
    try {
      await Promise.all(
        privyWallets.map((wallet) =>
          addSessionSigners({
            address: wallet.address,
            signers: [{ signerId: PRIVY_SIGNER_ID, policyIds: [] }],
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            // Idempotent — Privy throws "already exists" when the signer is
            // already attached. Treat that as success.
            if (!msg.toLowerCase().includes('already')) throw err
          }),
        ),
      )
      setDone(true)
    } catch (err: any) {
      setError(err?.message || 'Failed to connect agent. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">Connect Agent</h1>
          <p className="text-xs text-text-muted mt-0.5">
            Authorize the agent to sign payments from your Privy wallets
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/user')} icon={<ArrowLeft size={14} />}>
          Back to Instruments
        </Button>
      </div>

      <Card className="mx-auto max-w-lg space-y-5 p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-accent-muted p-2 text-accent">
            <ShieldCheck size={20} />
          </div>
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-text-primary">
              Give your agent access to your wallets
            </h2>
            <p className="text-xs leading-relaxed text-text-muted">
              Your agent will be able to send transactions and spend funds from your
              Privy wallets on your behalf. You can revoke access at any time from the
              Privy dashboard.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-3.5 py-3">
          <Info className="mt-px size-4 shrink-0 text-text-muted" />
          <p className="text-xs leading-snug text-text-muted">
            Transactions initiated by your agent cannot be reversed.
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-danger-muted px-3 py-2 text-xs text-danger">{error}</div>
        )}

        {done ? (
          <div className="rounded-lg bg-success/10 px-3 py-3 text-xs text-success">
            Agent connected. The session signer is attached to{' '}
            {privyWallets.length === 1 ? 'your wallet' : `${privyWallets.length} wallets`} —
            the agent can now sign x402 payments. You can close this page.
          </div>
        ) : !isPrivyAuthenticated ? (
          // ── Step 1: sign into Privy with the wallet owner's email ──
          <div className="space-y-3">
            <p className="text-xs text-text-secondary">
              Sign in with the email that owns your Privy wallets to continue.
            </p>
            {!otpSent ? (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-text-secondary">Email</label>
                <input
                  type="email"
                  value={otpEmail}
                  onChange={(e) => setOtpEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                />
                <Button
                  className="w-full"
                  disabled={otpSending || !otpEmail}
                  onClick={handleSendOtp}
                  icon={<Mail size={14} />}
                >
                  {otpSending ? 'Sending…' : 'Send verification code'}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-text-secondary">
                  Verification code sent to {otpEmail}
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder="123456"
                  className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm font-mono text-text-primary outline-none focus:border-accent"
                />
                <Button
                  className="w-full"
                  disabled={otpVerifying || !otpCode}
                  onClick={handleVerifyOtp}
                >
                  {otpVerifying ? 'Verifying…' : 'Verify and continue'}
                </Button>
                <button
                  type="button"
                  className="w-full text-center text-[11px] text-text-muted hover:text-text-secondary"
                  onClick={() => { setOtpSent(false); setOtpCode('') }}
                >
                  Use a different email
                </button>
              </div>
            )}
          </div>
        ) : (
          // ── Step 2: attach the session signer across all Privy wallets ──
          <div className="space-y-3">
            <p className="text-xs text-text-secondary">
              {privyWallets.length === 0
                ? 'No Privy wallets found on this account yet. Create a Privy instrument first, then return here.'
                : `Found ${privyWallets.length} Privy wallet${privyWallets.length === 1 ? '' : 's'} on this account.`}
            </p>
            <Button
              className="w-full"
              disabled={busy || privyWallets.length === 0}
              onClick={handleGiveAccess}
              icon={<ShieldCheck size={14} />}
            >
              {busy ? 'Connecting your agent…' : 'Give access'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
