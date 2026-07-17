import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function truncateArn(arn: string, maxLen = 40): string {
  if (arn.length <= maxLen) return arn
  return arn.slice(0, 20) + '…' + arn.slice(-18)
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function statusBadgeClasses(status: string): string {
  const s = (status || 'UNKNOWN').toUpperCase()
  if (['READY', 'ACTIVE', 'PROOF_GENERATED'].includes(s))
    return 'bg-success-muted text-success'
  if (['PENDING', 'CREATING', 'UPDATING'].includes(s))
    return 'bg-warning-muted text-warning'
  if (['FAILED', 'ERROR', 'DELETED'].includes(s))
    return 'bg-danger-muted text-danger'
  return 'bg-surface-3 text-text-secondary'
}

// ── Payment instrument wallet helpers ──────────────────────────────────

interface WalletDetails {
  network: string
  walletAddress?: string
  email?: string
  // Coinbase Wallet Hub URL. Populated only for Coinbase-managed
  // instruments when the service returns one. Used by the UI to point
  // the user at the hosted setup page in place of the legacy in-app
  // CDP OTP + delegation flow.
  redirectUrl?: string
}

/**
 * Read wallet info from a PaymentInstrument, handling both the legacy
 * `cryptoWallet` and the new `embeddedCryptoWallet` shapes.
 */
export function getWalletDetails(instrument: {
  paymentInstrumentDetails?: {
    cryptoWallet?: { network?: string; walletAddress?: string }
    embeddedCryptoWallet?: {
      network?: string
      walletAddress?: string
      linkedAccounts?: Array<{ email?: { emailAddress?: string } }>
      redirectUrl?: string
    }
  }
}): WalletDetails {
  const embedded = instrument.paymentInstrumentDetails?.embeddedCryptoWallet
  if (embedded) {
    return {
      network: embedded.network || 'ETHEREUM',
      walletAddress: embedded.walletAddress,
      email: embedded.linkedAccounts?.[0]?.email?.emailAddress,
      redirectUrl: embedded.redirectUrl,
    }
  }
  const legacy = instrument.paymentInstrumentDetails?.cryptoWallet
  if (legacy) {
    return {
      network: legacy.network || 'ETHEREUM',
      walletAddress: legacy.walletAddress,
    }
  }
  // No details on the record yet (e.g. a list row not yet enriched via
  // GetPaymentInstrument). Return an empty network so callers can show a
  // neutral placeholder instead of a misleading default.
  return { network: '' }
}

// ── Vendor helpers ─────────────────────────────────────────────────────

import type { Vendor, PaymentConnector, CredentialProvider, PaymentInstrument } from '@/types'

/**
 * Normalize various vendor string representations to the canonical `Vendor`
 * union. Returns null if the value isn't recognized so callers can decide how
 * to handle legacy/unknown rows.
 */
export function normalizeVendor(raw: string | undefined | null): Vendor | null {
  if (!raw) return null
  const v = raw.toLowerCase()
  if (v === 'coinbasecdp' || v === 'coinbase' || v === 'cdp') return 'CoinbaseCDP'
  if (v === 'stripeprivy' || v === 'stripe' || v === 'privy') return 'StripePrivy'
  return null
}

/** Read vendor off a credential provider. */
export function getCredentialProviderVendor(cp: CredentialProvider): Vendor | null {
  return normalizeVendor(cp.credentialProviderVendor)
}

/** Read vendor off a connector via its `type` field. */
export function getConnectorVendor(c: PaymentConnector): Vendor | null {
  return normalizeVendor(c.type)
}

/**
 * Read vendor off an instrument. Instruments don't carry vendor directly —
 * we look up their connector and read from there. If the lookup fails, we
 * fall back to null (caller can default to Coinbase for legacy rows).
 */
export function getInstrumentVendor(
  instrument: PaymentInstrument,
  connectors: PaymentConnector[],
): Vendor | null {
  const conn = connectors.find((c) => c.paymentConnectorId === instrument.paymentConnectorId)
  return conn ? getConnectorVendor(conn) : null
}

/** Human-friendly label for a vendor (what we show in UI). */
export function vendorLabel(v: Vendor | null): string {
  if (v === 'CoinbaseCDP') return 'Coinbase'
  if (v === 'StripePrivy') return 'Stripe'
  return 'Unknown'
}

/** Fine-print subtext for the vendor (where the actual wallet infra comes from). */
export function vendorSubLabel(v: Vendor | null): string {
  if (v === 'CoinbaseCDP') return 'Powered by CDP'
  if (v === 'StripePrivy') return 'Powered by Privy'
  return ''
}
