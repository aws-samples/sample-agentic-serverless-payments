/**
 * USDC balance for a payment instrument.
 *
 * Uses the AgentCore Payments data-plane GetPaymentInstrumentBalance API
 * via our backend. The backend requires manager ARN and connector ID in
 * the query string and scopes to the caller's Cognito sub automatically.
 *
 * No direct chain RPCs — the service abstracts EVM and Solana behind a
 * single call. Native-token (ETH/SOL) balance isn't surfaced since the
 * x402 flow is gasless for the user.
 */
import { getInstrumentBalance } from './api'
import type { PaymentInstrument, PaymentConnector, PaymentManager } from '@/types'

export interface InstrumentContext {
  managerArn: string
  connectorId: string
}

/**
 * Resolve the (managerArn, connectorId) pair for an instrument by walking
 * connector → manager in the local cache. Returns empty strings when the
 * connector or manager isn't loaded yet — caller can bail rather than hit
 * the API with incomplete context.
 */
export function resolveInstrumentContext(
  instrument: PaymentInstrument,
  connectors: PaymentConnector[],
  managers: PaymentManager[],
): InstrumentContext {
  const connector = connectors.find((c) => c.paymentConnectorId === instrument.paymentConnectorId)
  const manager = managers.find((m) => m.paymentManagerId === connector?.paymentManagerId)
  return {
    managerArn: manager?.paymentManagerArn || instrument.paymentManagerArn || '',
    connectorId: instrument.paymentConnectorId || '',
  }
}

export async function getUsdcBalance(
  instrument: PaymentInstrument,
  ctx: InstrumentContext,
): Promise<string> {
  if (!ctx.managerArn || !ctx.connectorId) {
    console.warn('getUsdcBalance: missing manager/connector context')
    return '—'
  }
  // Map network to chain the way the backend does:
  //   ETHEREUM → BASE_SEPOLIA, SOLANA → SOLANA_DEVNET.
  const network = instrument.paymentInstrumentDetails?.embeddedCryptoWallet?.network
    || instrument.paymentInstrumentDetails?.cryptoWallet?.network
    || 'ETHEREUM'
  const chain = network === 'SOLANA' ? 'SOLANA_DEVNET' : 'BASE_SEPOLIA'
  try {
    const resp = await getInstrumentBalance(instrument.paymentInstrumentId, {
      managerArn: ctx.managerArn,
      connectorId: ctx.connectorId,
      chain,
    })
    const tb = resp?.tokenBalance
    if (!tb) return '—'
    const amount = BigInt(tb.amount)
    const decimals = Number(tb.decimals || 6)
    const divisor = 10n ** BigInt(decimals)
    const whole = amount / divisor
    const fraction = amount % divisor
    const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 6)
    return `${whole.toString()}.${fractionStr}`
  } catch (e) {
    // Log only the message, not the raw exception object, which could carry
    // API-response detail.
    console.warn('Failed to fetch instrument balance:', e instanceof Error ? e.message : String(e))
    return '—'
  }
}
