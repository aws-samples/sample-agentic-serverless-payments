// ── Control Plane Resources ──

/** Supported payment credential vendors. */
export type Vendor = 'CoinbaseCDP' | 'StripePrivy'

export interface CredentialProvider {
  name: string
  credentialProviderVendor: string
  credentialProviderArn: string
  providerConfigurationOutput?: {
    coinbaseCdpConfiguration?: {
      apiKeyId: string
      apiKeySecretArn?: { secretArn: string }
      walletSecretArn?: { secretArn: string }
    }
    stripePrivyConfiguration?: {
      appId: string
      appSecretArn?: { secretArn: string }
      authorizationId: string
      authorizationPrivateKeyArn?: { secretArn: string }
    }
  }
  createdAt?: string
  updatedAt?: string
  status?: string
}

export interface PaymentManager {
  paymentManagerId: string
  paymentManagerArn: string
  name: string
  description?: string
  authorizerType: string
  roleArn: string
  workloadIdentityDetails?: {
    workloadIdentityArn: string
  }
  status: string
  createdAt?: string
  updatedAt?: string
}

export interface PaymentConnector {
  paymentConnectorId: string
  paymentManagerId: string
  name: string
  description?: string
  type: string
  credentialProviderConfigurations: Array<{
    coinbaseCDP?: { credentialProviderArn: string }
    stripePrivy?: { credentialProviderArn: string }
  }>
  status: string
  createdAt?: string
  updatedAt?: string
}

// ── Data Plane Resources ──

export interface LinkedAccount {
  email?: { emailAddress: string }
}

export interface PaymentInstrument {
  paymentInstrumentId: string
  paymentManagerArn: string
  paymentConnectorId: string
  userId: string
  paymentInstrumentType: string
  paymentInstrumentDetails: {
    // Legacy externally-owned wallet (kept for backward compat with older records)
    cryptoWallet?: {
      network: string
      walletAddress?: string
    }
    // Coinbase-managed embedded wallet linked to a user account (email)
    embeddedCryptoWallet?: {
      network: string
      walletAddress?: string
      linkedAccounts?: LinkedAccount[]
      // Coinbase Wallet Hub URL returned by CreatePaymentInstrument for
      // Coinbase-managed wallets. The user opens this in a new tab to
      // complete email verification + signing delegation on a Coinbase-
      // hosted page, which replaces the in-app CDP OTP + grant flow.
      // Privy-managed instruments don't get this field.
      redirectUrl?: string
    }
  }
  status: string
  createdAt?: string
  updatedAt?: string
}

export interface PaymentSession {
  paymentSessionId: string
  paymentManagerArn: string
  userId: string
  limits: {
    maxSpendAmount: {
      value: string
      currency: string
    }
  }
  expiryTimeInMinutes: number
  status?: string
  currentSpendAmount?: {
    value: string
    currency: string
  }
  createdAt?: string
  updatedAt?: string
}

export interface ProcessPaymentResult {
  processPaymentId: string
  paymentManagerArn: string
  paymentSessionId: string
  paymentInstrumentId: string
  paymentType: string
  status: string
  paymentOutput?: {
    cryptoX402?: {
      version: string
      payload: {
        authorization: Record<string, string>
        signature: string
      }
    }
  }
  createdAt?: string
}

// ── Agent Chat ──

export type AgentMessageRole = 'user' | 'agent' | 'system'

export interface AgentMessage {
  id: string
  role: AgentMessageRole
  content: string
  timestamp: number
  isStreaming?: boolean
  metadata?: Record<string, unknown>
  mediaUrl?: string
  mediaType?: 'image' | 'audio'
  mediaTitle?: string
}

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

// ── Dashboard ──

export interface ResourceCounts {
  credentialProviders: number
  paymentManagers: number
  paymentConnectors: number
}
