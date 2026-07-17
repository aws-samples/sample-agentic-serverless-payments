/**
 * API client — all requests go through here.
 * Injects Cognito ID token as Bearer auth.
 * Points directly at the deployed API Gateway.
 */
import { getIdToken } from './auth'

const API_BASE = import.meta.env.VITE_API_URL as string

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getIdToken()
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...headers, ...init?.headers } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`)
  return body as T
}

// ── Admin: Credential Providers ──
export const listCredentialProviders = () =>
  request<{ credentialProviders: any[] }>('/admin/credential-providers')

export const createCredentialProvider = (data: {
  name: string
  // CoinbaseCDP (default) or StripePrivy — backend routes to the right endpoint.
  vendor?: 'CoinbaseCDP' | 'StripePrivy'
  // CoinbaseCDP fields
  apiKeyId?: string
  apiKeySecret?: string
  walletSecret?: string
  // StripePrivy fields
  appId?: string
  appSecret?: string
  authorizationId?: string
  authorizationPrivateKey?: string
}) => request<any>('/admin/credential-providers', { method: 'POST', body: JSON.stringify(data) })

export const deleteCredentialProvider = (name: string, vendor?: string) =>
  request<any>(
    `/admin/credential-providers/${name}${vendor ? `?vendor=${encodeURIComponent(vendor)}` : ''}`,
    { method: 'DELETE' },
  )

// Credential rotation — UpdatePaymentCredentialProvider is a full replace of
// providerConfigurationInput, so callers must resubmit the vendor secrets.
export const updateCredentialProvider = (name: string, data: {
  vendor: 'CoinbaseCDP' | 'StripePrivy'
  apiKeyId?: string
  apiKeySecret?: string
  walletSecret?: string
  appId?: string
  appSecret?: string
  authorizationId?: string
  authorizationPrivateKey?: string
}) => request<any>(`/admin/credential-providers/${name}`, {
  method: 'PUT',
  body: JSON.stringify(data),
})

// ── User: Payment Options (bootstrap, READ-ONLY) ──
// Lets a non-admin user discover the platform manager ARN + connector id they
// need to create their first instrument/session, without the admin endpoints.
// Returns only non-sensitive identifiers (no role ARNs / credential ARNs).
export const getPaymentOptions = () =>
  request<{ paymentOptions: Array<{
    managerName: string
    paymentManagerArn: string
    paymentManagerId: string
    status: string
    connectors: Array<{ connectorName: string; paymentConnectorId: string; type: string; status: string }>
  }> }>('/user/payment-options')

// ── Admin: Payment Managers ──
export const listPaymentManagers = () =>
  request<{ paymentManagers: any[] }>('/admin/managers')

export const createPaymentManager = (data: { name: string; description?: string }) =>
  request<any>('/admin/managers', { method: 'POST', body: JSON.stringify(data) })

export const deletePaymentManager = (id: string) =>
  request<any>(`/admin/managers/${id}`, { method: 'DELETE' })

export const updatePaymentManager = (id: string, data: { description?: string }) =>
  request<any>(`/admin/managers/${id}`, { method: 'PUT', body: JSON.stringify(data) })

// ── Admin: Payment Connectors ──
export const listPaymentConnectors = (managerId: string) =>
  request<{ paymentConnectors: any[] }>(`/admin/connectors?managerId=${managerId}`)

export const createPaymentConnector = (data: {
  paymentManagerId: string
  name: string
  description?: string
  credentialProviderArn: string
  /** Connector type — matches the credential provider's vendor. Defaults to CoinbaseCDP on the backend. */
  type?: 'CoinbaseCDP' | 'StripePrivy'
}) => request<any>('/admin/connectors', { method: 'POST', body: JSON.stringify(data) })

export const deletePaymentConnector = (managerId: string, connectorId: string) =>
  request<any>(`/admin/connectors/${connectorId}?managerId=${managerId}`, { method: 'DELETE' })

export const updatePaymentConnector = (managerId: string, connectorId: string, data: {
  description?: string
  type?: 'CoinbaseCDP' | 'StripePrivy'
  credentialProviderArn?: string
}) => request<any>(`/admin/connectors/${connectorId}?managerId=${managerId}`, {
  method: 'PUT',
  body: JSON.stringify({ ...data, paymentManagerId: managerId }),
})

// ── User: Instruments ──

// Low-level list — always scoped to a single manager (service requirement).
// Low-level list — always scoped to a single manager (service requirement).
// The backend scopes to the caller's Cognito sub automatically; callers that
// want an "all my wallets" view use `listAllInstruments` below which fans out
// over managers. The list response carries IDs + status but NOT the wallet
// address — use `getInstrument` to enrich a row with address/details.
export const listInstruments = (opts?: {
  managerArn?: string
  connectorId?: string
}) => {
  const params = new URLSearchParams()
  if (opts?.managerArn) params.set('managerArn', opts.managerArn)
  if (opts?.connectorId) params.set('connectorId', opts.connectorId)
  const qs = params.toString()
  return request<{ paymentInstruments: any[] }>(
    `/user/instruments${qs ? `?${qs}` : ''}`,
  )
}

// GetPaymentInstrument — returns the full instrument including
// paymentInstrumentDetails.embeddedCryptoWallet (walletAddress, redirectUrl,
// network, linkedAccounts). Used to enrich list rows, which don't carry the
// wallet address. Requires managerArn + connectorId.
export const getInstrument = (
  instrumentId: string,
  opts: { managerArn: string; connectorId: string },
) => {
  const params = new URLSearchParams()
  params.set('managerArn', opts.managerArn)
  params.set('connectorId', opts.connectorId)
  return request<{ paymentInstrument: any }>(
    `/user/instruments/${instrumentId}?${params.toString()}`,
  )
}

/**
 * List every instrument the user owns by fanning out over the payment
 * managers supplied by the caller (admin store holds them in state).
 *
 * Every instrument is scoped server-side to the caller's Cognito sub, so a
 * single list call per manager surfaces all of that user's wallets. Results
 * are de-duplicated by paymentInstrumentId.
 */
export const listAllInstruments = async (
  managerArns: string[],
): Promise<{ paymentInstruments: any[] }> => {
  const calls = managerArns.map((arn) => listInstruments({ managerArn: arn }))
  const settled = await Promise.allSettled(calls)
  const all = settled
    .filter((r): r is PromiseFulfilledResult<{ paymentInstruments: any[] }> => r.status === 'fulfilled')
    .flatMap((r) => r.value.paymentInstruments || [])

  // De-duplicate by paymentInstrumentId.
  const seen = new Set<string>()
  const deduped = all.filter((i) => {
    const id = i?.paymentInstrumentId
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
  return { paymentInstruments: deduped }
}

export const createInstrument = (data: {
  paymentManagerArn: string
  paymentConnectorId: string
  network?: string
  email?: string
}) => request<any>('/user/instruments', { method: 'POST', body: JSON.stringify(data) })

// GetPaymentInstrumentBalance — returns USDC balance on the chain that maps
// to the instrument's network (BASE_SEPOLIA for EVM, SOLANA_DEVNET for Solana).
// Backend requires managerArn + connectorId and scopes to the caller's
// Cognito sub automatically.
export const getInstrumentBalance = (
  instrumentId: string,
  opts?: { managerArn?: string; connectorId?: string; chain?: string; token?: string },
) => {
  const params = new URLSearchParams()
  if (opts?.managerArn) params.set('managerArn', opts.managerArn)
  if (opts?.connectorId) params.set('connectorId', opts.connectorId)
  if (opts?.chain) params.set('chain', opts.chain)
  if (opts?.token) params.set('token', opts.token)
  const qs = params.toString()
  return request<{
    paymentInstrumentId: string
    tokenBalance: { amount: string; decimals: number; token: string; network: string; chain: string }
  }>(`/user/instruments/${instrumentId}/balance${qs ? `?${qs}` : ''}`)
}

// DeletePaymentInstrument — soft-deletes the instrument server-side (status
// flips to DELETED, record retained for audit). Backend scopes to the
// caller's Cognito sub; requires managerArn + connectorId.
export const deleteInstrument = (
  instrumentId: string,
  opts?: { managerArn?: string; connectorId?: string },
) => {
  const params = new URLSearchParams()
  if (opts?.managerArn) params.set('managerArn', opts.managerArn)
  if (opts?.connectorId) params.set('connectorId', opts.connectorId)
  const qs = params.toString()
  return request<{ status: string }>(
    `/user/instruments/${instrumentId}${qs ? `?${qs}` : ''}`,
    { method: 'DELETE' },
  )
}

// ── User: Sessions ──

// Low-level list — scoped to a single manager (service requirement). The
// backend scopes to the caller's Cognito sub. Use `listAllSessions` for the
// "all my sessions" view.
export const listSessions = (opts?: {
  managerArn?: string
}) => {
  const params = new URLSearchParams()
  if (opts?.managerArn) params.set('managerArn', opts.managerArn)
  const qs = params.toString()
  return request<{ paymentSessions: any[] }>(
    `/user/sessions${qs ? `?${qs}` : ''}`,
  )
}

/**
 * List every session the user owns across all known managers. Each session
 * lives under the caller's Cognito sub (same identity as the instruments),
 * so a single list call per manager surfaces all of that user's sessions.
 */
export const listAllSessions = async (
  managerArns: string[],
): Promise<{ paymentSessions: any[] }> => {
  const calls = managerArns.map((arn) => listSessions({ managerArn: arn }))
  const settled = await Promise.allSettled(calls)
  const all = settled
    .filter((r): r is PromiseFulfilledResult<{ paymentSessions: any[] }> => r.status === 'fulfilled')
    .flatMap((r) => r.value.paymentSessions || [])
  // Dedupe by paymentSessionId.
  const seen = new Set<string>()
  const deduped = all.filter((s) => {
    const id = s?.paymentSessionId
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
  return { paymentSessions: deduped }
}

export const getSession = (id: string, managerArn?: string) => {
  const params = new URLSearchParams()
  if (managerArn) params.set('managerArn', managerArn)
  const qs = params.toString()
  return request<any>(`/user/sessions/${id}${qs ? `?${qs}` : ''}`)
}

export const createSession = (data: {
  paymentManagerArn: string
  maxSpendAmount?: { value: string; currency: string }
  expiryTimeInMinutes?: number
}) => request<any>('/user/sessions', { method: 'POST', body: JSON.stringify(data) })

// DeletePaymentSession — hard-deletes the session server-side (record is
// permanently removed, no undelete). Backend scopes to the caller's Cognito
// sub; requires managerArn.
export const deleteSession = (
  sessionId: string,
  opts?: { managerArn?: string },
) => {
  const params = new URLSearchParams()
  if (opts?.managerArn) params.set('managerArn', opts.managerArn)
  const qs = params.toString()
  return request<{ status: string }>(
    `/user/sessions/${sessionId}${qs ? `?${qs}` : ''}`,
    { method: 'DELETE' },
  )
}

// ── User: Agent WebSocket ──
export const getAgentWsUrl = () =>
  request<{ wsUrl: string; sessionId: string; userId: string; expiresIn: number; runtimeArn: string }>('/user/agent/ws-url')

// ── User: Agent REST text invocation (fallback for text-only mode) ──
export const invokeAgent = (prompt: string, userId?: string) =>
  request<{ response: string }>('/user/agent/invoke', {
    method: 'POST',
    body: JSON.stringify({ prompt, userId }),
  })

// ══════════════════════════════════════════════════════════════════
// Agent-economy storefront API (separate API Gateway, NO Cognito).
// The storefront uses x402 payment proofs as the auth for orders; the admin
// seller-setup/orders endpoints are unauthenticated for the demo. Points at
// VITE_STOREFRONT_API_URL.
// ══════════════════════════════════════════════════════════════════
const STOREFRONT_BASE = (import.meta.env.VITE_STOREFRONT_API_URL as string) || ''

async function storeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${STOREFRONT_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Storefront request failed: ${res.status}`)
  return body as T
}

// Products (public — stays on the Cognito-free storefront API)
export const listStoreProducts = () =>
  storeRequest<{ products: any[] }>('/products')

// Seller config + setup (ADMIN — moved to the main Cognito API behind
// require_admin). Uses the authed `request` so the ID token is attached.
export const getSellerConfig = () =>
  request<{ config: any }>('/admin/storefront/seller/config')

export const setupSeller = (data: {
  apiKeyId: string
  apiKeySecret: string
  walletSecret?: string
  walletEmail: string
}) => request<{ config: any; delegation: any }>('/admin/storefront/seller/setup', {
  method: 'POST',
  body: JSON.stringify(data),
})

// Orders list + refund (ADMIN — main Cognito API). The admin route is the only
// place a FORCE refund is honored; the agent's public refund cannot force.
export const listStoreOrders = () =>
  request<{ orders: any[] }>('/admin/storefront/orders')

export const refundStoreOrder = (orderId: string, force = false) =>
  request<{ order: any; refund: any }>(`/admin/storefront/orders/${orderId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  })

// Buyer's digital library (AUTHENTICATED — lives on the main API, scoped to the
// caller's Cognito sub). Returns purchased digital-file goods (order-backed, so
// refunded items disappear and downloaded items are flagged non-refundable) and
// saved generated media.
export const getLibrary = () =>
  request<{ items: any[] }>('/user/library')

// Full order history (AUTHENTICATED, scoped to the caller's sub): every order,
// physical and digital, all statuses — the "Your Orders" view.
export const getOrderHistory = () =>
  request<{ orders: any[] }>('/user/orders')
