/**
 * Privy Embedded Wallet provider — only wraps the app when `VITE_PRIVY_APP_ID`
 * is set, so deploys without Privy configured stay clean.
 *
 * The AgentCore StripePrivy credential provider creates wallets server-side,
 * keyed by `linkedAccounts.email`. For the agent to sign x402 payments
 * against those wallets, the authorization-key quorum registered with
 * AgentCore must be attached as a session signer on each wallet. That
 * attach-the-signer step is a one-time, per-wallet user action — the user
 * signs into Privy with the email that matches the wallet's owner and calls
 * `addSessionSigners`.
 *
 * No auto sign-in at the root; the email OTP + signer-attach flow lives on
 * the Connect Agent page and only fires when the user explicitly connects
 * the agent.
 */
import { type ReactNode, useEffect, useRef } from 'react'
import { PrivyProvider as PrivyRootProvider, usePrivy, useLogout } from '@privy-io/react-auth'
import { useAuthStore } from '@/store/auth'

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined

type Props = {
  children: ReactNode
}

/**
 * Clears the Privy session when the Cognito user changes or logs out so
 * the next Cognito user starts fresh.
 */
function PrivyBootstrap({ children }: { children: ReactNode }) {
  const { user, authenticated } = usePrivy()
  const { logout } = useLogout()
  const cognitoEmail = useAuthStore((s) => s.email)
  const cognitoAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const lastCognitoEmailRef = useRef<string | null>(null)

  useEffect(() => {
    const privyEmail =
      user?.email?.address ||
      (user?.linkedAccounts ?? []).find((a) => a.type === 'email')?.address ||
      null

    // Cognito signed out — drop the Privy session.
    if (!cognitoAuthenticated || !cognitoEmail) {
      if (authenticated) {
        logout().catch(() => {})
      }
      lastCognitoEmailRef.current = null
      return
    }

    // Cognito email changed and Privy is still on a different user → clear.
    const cognitoChanged = lastCognitoEmailRef.current !== cognitoEmail
    const mismatch =
      !!privyEmail && privyEmail.toLowerCase() !== cognitoEmail.toLowerCase()

    if (cognitoChanged && mismatch) {
      logout().catch(() => {})
    }

    lastCognitoEmailRef.current = cognitoEmail
  }, [user, authenticated, cognitoAuthenticated, cognitoEmail, logout])

  return <>{children}</>
}

export function PrivyProvider({ children }: Props) {
  if (!PRIVY_APP_ID) {
    if (typeof window !== 'undefined') {
      console.warn('[PrivyProvider] VITE_PRIVY_APP_ID is not set — Privy signer attach disabled')
    }
    return <>{children}</>
  }

  return (
    <PrivyRootProvider
      appId={PRIVY_APP_ID}
      config={{
        // Wallets are created server-side by AgentCore — don't auto-create
        // them here or we'd get duplicates.
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' },
          solana: { createOnLogin: 'off' },
        },
        // Email OTP is the flow we want — matches the email-keyed user that
        // AgentCore creates via `linkedAccounts: [{ email }]`.
        loginMethods: ['email'],
      }}
    >
      <PrivyBootstrap>{children}</PrivyBootstrap>
    </PrivyRootProvider>
  )
}
