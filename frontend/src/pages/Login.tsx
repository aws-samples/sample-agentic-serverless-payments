import { useState } from 'react'
import { useAuthStore } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { CreditCard } from 'lucide-react'
import { cn } from '@/lib/utils'

type Tab = 'signin' | 'signup'
type SignUpStep = 'form' | 'confirm'

export function Login() {
  const {
    signIn, signUp, confirmSignUp,
    loading, error, needsConfirmation, clearNeedsConfirmation, clearError, pendingEmail,
  } = useAuthStore()
  const [tab, setTab] = useState<Tab>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [signUpStep, setSignUpStep] = useState<SignUpStep>('form')
  const [localError, setLocalError] = useState('')
  const [info, setInfo] = useState('')

  const displayError = localError || error

  const resetForm = () => {
    setEmail('')
    setPassword('')
    setCode('')
    setLocalError('')
    setInfo('')
    setSignUpStep('form')
    clearError()
    clearNeedsConfirmation()
  }

  const switchTab = (t: Tab) => {
    setTab(t)
    resetForm()
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError('')
    setInfo('')
    if (!email.trim() || !password) { setLocalError('Email and password are required'); return }
    try {
      await signIn(email.trim(), password)
    } catch {
      // Store handles error + needsConfirmation flag
    }
  }

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError('')
    setInfo('')
    if (!email.trim() || !password) { setLocalError('Email and password are required'); return }
    if (password.length < 8) { setLocalError('Password must be at least 8 characters'); return }
    try {
      await signUp(email.trim(), password)
      setSignUpStep('confirm')
    } catch (err: any) {
      setLocalError(err.message || 'Sign up failed')
    }
  }

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError('')
    setInfo('')
    const confirmEmail = email.trim() || pendingEmail || ''
    const trimmedCode = code.trim()
    if (!confirmEmail) { setLocalError('Your session expired. Please start sign up again.'); return }
    if (!trimmedCode) { setLocalError('Verification code is required'); return }

    try {
      await confirmSignUp(confirmEmail, trimmedCode)
    } catch (err: any) {
      setLocalError(err.message || 'Confirmation failed')
      return
    }

    // Email is confirmed. Sign in automatically so the user lands in the app
    // without a second step. Cognito can briefly reject the first authenticate
    // right after confirmation (eventual consistency), so retry a few times
    // before falling back to manual sign-in.
    if (password) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await signIn(confirmEmail, password)
          return // authenticated — App routes into the app
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 800))
        }
      }
    }

    // Could not auto sign-in (no password retained, or a persistent transient).
    // Return to a clean sign-in with a success message, never a raw error.
    clearError()
    clearNeedsConfirmation()
    setSignUpStep('form')
    setTab('signin')
    setEmail(confirmEmail)
    setCode('')
    setLocalError('')
    setInfo('Your email is verified. Sign in to continue.')
  }

  const showConfirmForm = (tab === 'signup' && signUpStep === 'confirm') || needsConfirmation

  const subtitle = showConfirmForm
    ? 'Check your email for a code'
    : tab === 'signin'
      ? 'Sign in to continue'
      : 'Create an account'

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-1 p-8 shadow-lg space-y-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-white">
            <CreditCard size={24} />
          </div>
          <h1 className="text-lg font-bold text-text-primary">AgentCore Payments</h1>
          <p className="text-xs text-text-muted">{subtitle}</p>
        </div>

        {!showConfirmForm && (
          <div className="flex rounded-lg bg-surface-2 p-0.5">
            {(['signin', 'signup'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => switchTab(t)}
                className={cn(
                  'flex-1 rounded-md py-1.5 text-xs font-medium transition-all',
                  tab === t
                    ? 'bg-surface-1 text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary',
                )}
              >
                {t === 'signin' ? 'Sign In' : 'Sign Up'}
              </button>
            ))}
          </div>
        )}

        {displayError && (
          <div className="rounded-lg bg-danger-muted px-3 py-2 text-xs text-danger">
            {displayError}
          </div>
        )}

        {info && !displayError && (
          <div className="rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
            {info}
          </div>
        )}

        {tab === 'signin' && !needsConfirmation && (
          <form onSubmit={handleSignIn} className="space-y-4">
            <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
            <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required />
            <Button type="submit" className="w-full" disabled={!email || !password || loading}>
              {loading ? 'Signing in…' : 'Sign In'}
            </Button>
          </form>
        )}

        {tab === 'signup' && signUpStep === 'form' && (
          <form onSubmit={handleSignUp} className="space-y-4">
            <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
            <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 8 chars" autoComplete="new-password" required />
            <Button type="submit" className="w-full" disabled={!email || !password || loading}>
              {loading ? 'Creating account…' : 'Create Account'}
            </Button>
          </form>
        )}

        {showConfirmForm && (
          <form onSubmit={handleConfirm} className="space-y-4">
            <p className="text-xs text-text-secondary text-center">
              Enter the verification code sent to{' '}
              <span className="font-medium text-text-primary">{email.trim() || pendingEmail || 'your email'}</span>
            </p>
            <Input label="Verification Code" type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoComplete="one-time-code" required autoFocus />
            <Button type="submit" className="w-full" disabled={!code.trim() || loading}>
              {loading ? 'Verifying…' : 'Verify'}
            </Button>
            <button type="button" onClick={resetForm} className="w-full text-xs text-text-muted hover:text-text-secondary transition-colors">
              ← Back
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
