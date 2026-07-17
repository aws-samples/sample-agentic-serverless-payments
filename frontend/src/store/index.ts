import { create } from 'zustand'
import type {
  CredentialProvider, PaymentManager, PaymentConnector,
  PaymentInstrument, PaymentSession, ProcessPaymentResult,
  AgentMessage, WebSocketStatus,
} from '@/types'

interface AdminState {
  credentialProviders: CredentialProvider[]
  paymentManagers: PaymentManager[]
  paymentConnectors: PaymentConnector[]
  _prefetched: boolean
  setCredentialProviders: (v: CredentialProvider[]) => void
  setPaymentManagers: (v: PaymentManager[]) => void
  setPaymentConnectors: (v: PaymentConnector[]) => void
  addCredentialProvider: (v: CredentialProvider) => void
  addPaymentManager: (v: PaymentManager) => void
  addPaymentConnector: (v: PaymentConnector) => void
  updateCredentialProvider: (name: string, patch: Partial<CredentialProvider>) => void
  updatePaymentManager: (id: string, patch: Partial<PaymentManager>) => void
  updatePaymentConnector: (managerId: string, connectorId: string, patch: Partial<PaymentConnector>) => void
  removeCredentialProvider: (name: string) => void
  removePaymentManager: (id: string) => void
  removePaymentConnector: (managerId: string, connectorId: string) => void
  markPrefetched: () => void
  reset: () => void
}

const ADMIN_INITIAL = {
  credentialProviders: [] as CredentialProvider[],
  paymentManagers: [] as PaymentManager[],
  paymentConnectors: [] as PaymentConnector[],
  _prefetched: false,
}

export const useAdminStore = create<AdminState>((set) => ({
  ...ADMIN_INITIAL,
  setCredentialProviders: (v) => set({ credentialProviders: v }),
  setPaymentManagers: (v) => set({ paymentManagers: v }),
  setPaymentConnectors: (v) => set({ paymentConnectors: v }),
  addCredentialProvider: (v) => set((s) => ({
    credentialProviders: [v, ...s.credentialProviders],
  })),
  addPaymentManager: (v) => set((s) => ({
    paymentManagers: [v, ...s.paymentManagers],
  })),
  addPaymentConnector: (v) => set((s) => ({
    paymentConnectors: [v, ...s.paymentConnectors],
  })),
  updateCredentialProvider: (name, patch) => set((s) => ({
    credentialProviders: s.credentialProviders.map((p) => p.name === name ? { ...p, ...patch } : p),
  })),
  updatePaymentManager: (id, patch) => set((s) => ({
    paymentManagers: s.paymentManagers.map((m) => m.paymentManagerId === id ? { ...m, ...patch } : m),
  })),
  updatePaymentConnector: (managerId, connectorId, patch) => set((s) => ({
    paymentConnectors: s.paymentConnectors.map((c) =>
      c.paymentManagerId === managerId && c.paymentConnectorId === connectorId ? { ...c, ...patch } : c
    ),
  })),
  removeCredentialProvider: (name) => set((s) => ({
    credentialProviders: s.credentialProviders.filter((p) => p.name !== name),
  })),
  removePaymentManager: (id) => set((s) => ({
    paymentManagers: s.paymentManagers.filter((m) => m.paymentManagerId !== id),
  })),
  removePaymentConnector: (managerId, connectorId) => set((s) => ({
    paymentConnectors: s.paymentConnectors.filter(
      (c) => !(c.paymentManagerId === managerId && c.paymentConnectorId === connectorId)
    ),
  })),
  markPrefetched: () => set({ _prefetched: true }),
  // Restore initial state. Called on sign-out so control-plane data fetched
  // during an admin session never leaks into a subsequent user session.
  reset: () => set({ ...ADMIN_INITIAL }),
}))

interface UserState {
  instruments: PaymentInstrument[]
  sessions: PaymentSession[]
  transactions: ProcessPaymentResult[]
  _prefetched: boolean
  setInstruments: (v: PaymentInstrument[]) => void
  setSessions: (v: PaymentSession[]) => void
  setTransactions: (v: ProcessPaymentResult[]) => void
  addInstrument: (v: PaymentInstrument) => void
  addSession: (v: PaymentSession) => void
  addTransaction: (v: ProcessPaymentResult) => void
  removeInstrument: (id: string) => void
  removeSession: (id: string) => void
  markPrefetched: () => void
  reset: () => void
}

const USER_INITIAL = {
  instruments: [] as PaymentInstrument[],
  sessions: [] as PaymentSession[],
  transactions: [] as ProcessPaymentResult[],
  _prefetched: false,
}

export const useUserStore = create<UserState>((set) => ({
  ...USER_INITIAL,
  setInstruments: (v) => set({ instruments: v }),
  setSessions: (v) => set({ sessions: v }),
  setTransactions: (v) => set({ transactions: v }),
  addInstrument: (v) => set((s) => ({ instruments: [v, ...s.instruments] })),
  addSession: (v) => set((s) => ({ sessions: [v, ...s.sessions] })),
  addTransaction: (v) => set((s) => ({ transactions: [v, ...s.transactions] })),
  removeInstrument: (id) => set((s) => ({
    instruments: s.instruments.filter((i) => i.paymentInstrumentId !== id),
  })),
  removeSession: (id) => set((s) => ({
    sessions: s.sessions.filter((x) => x.paymentSessionId !== id),
  })),
  markPrefetched: () => set({ _prefetched: true }),
  reset: () => set({ ...USER_INITIAL }),
}))

interface ChatState {
  messages: AgentMessage[]
  wsStatus: WebSocketStatus
  isVoiceMode: boolean
  addMessage: (m: AgentMessage) => void
  updateMessage: (id: string, content: string, streaming?: boolean) => void
  setWsStatus: (s: WebSocketStatus) => void
  toggleVoiceMode: () => void
  clearMessages: () => void
  reset: () => void
}

const CHAT_INITIAL = {
  messages: [] as AgentMessage[],
  wsStatus: 'disconnected' as WebSocketStatus,
  isVoiceMode: false,
}

export const useChatStore = create<ChatState>((set) => ({
  ...CHAT_INITIAL,
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  updateMessage: (id, content, streaming) => set((s) => ({
    messages: s.messages.map((m) => m.id === id ? { ...m, content, isStreaming: streaming ?? false } : m),
  })),
  setWsStatus: (wsStatus) => set({ wsStatus }),
  toggleVoiceMode: () => set((s) => ({ isVoiceMode: !s.isVoiceMode })),
  clearMessages: () => set({ messages: [] }),
  reset: () => set({ ...CHAT_INITIAL }),
}))
