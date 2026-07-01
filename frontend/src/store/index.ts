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
}

export const useAdminStore = create<AdminState>((set) => ({
  credentialProviders: [],
  paymentManagers: [],
  paymentConnectors: [],
  _prefetched: false,
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
}

export const useUserStore = create<UserState>((set) => ({
  instruments: [],
  sessions: [],
  transactions: [],
  _prefetched: false,
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
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  wsStatus: 'disconnected',
  isVoiceMode: false,
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  updateMessage: (id, content, streaming) => set((s) => ({
    messages: s.messages.map((m) => m.id === id ? { ...m, content, isStreaming: streaming ?? false } : m),
  })),
  setWsStatus: (wsStatus) => set({ wsStatus }),
  toggleVoiceMode: () => set((s) => ({ isVoiceMode: !s.isVoiceMode })),
  clearMessages: () => set({ messages: [] }),
}))
