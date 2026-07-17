import { create } from 'zustand'
import {
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  getSession,
  getRoleFromSession,
  signUp as cognitoSignUp,
  confirmSignUp as cognitoConfirmSignUp,
} from '@/lib/auth'
import type { UserRole } from '@/lib/auth'
import { useAdminStore, useUserStore, useChatStore } from '@/store'

interface AuthState {
  isAuthenticated: boolean
  email: string | null
  userId: string | null
  role: UserRole | null
  loading: boolean
  initialized: boolean
  error: string | null
  needsConfirmation: boolean
  pendingEmail: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  confirmSignUp: (email: string, code: string) => Promise<void>
  clearError: () => void
  clearNeedsConfirmation: () => void
  signOut: () => void
  checkSession: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  email: null,
  userId: null,
  role: null,
  loading: true,
  initialized: false,
  error: null,
  needsConfirmation: false,
  pendingEmail: null,

  signIn: async (email, password) => {
    set({ loading: true, error: null, needsConfirmation: false })
    try {
      const session = await cognitoSignIn(email, password)
      const payload = session.getIdToken().payload
      const role = getRoleFromSession(session)
      set({
        isAuthenticated: true,
        email: payload.email as string,
        userId: payload.sub as string,
        role,
        loading: false,
        pendingEmail: null,
      })
    } catch (err: any) {
      const msg = err.message || 'Sign in failed'
      const isUnconfirmed = msg.includes('not confirmed') || err.__type === 'UserNotConfirmedException' || err.code === 'UserNotConfirmedException'
      set({
        loading: false,
        error: isUnconfirmed ? null : msg,
        needsConfirmation: isUnconfirmed,
        // Remember the email so the verification step always has it, even if
        // it reached that step from the sign-in form.
        pendingEmail: isUnconfirmed ? email : undefined,
      })
      throw err
    }
  },

  signUp: async (email, password) => {
    set({ loading: true, error: null })
    try {
      await cognitoSignUp(email, password)
      set({ loading: false, pendingEmail: email })
    } catch (err: any) {
      set({ loading: false, error: err.message || 'Sign up failed' })
      throw err
    }
  },

  confirmSignUp: async (email, code) => {
    set({ loading: true, error: null })
    try {
      await cognitoConfirmSignUp(email, code)
      set({ loading: false })
    } catch (err: any) {
      set({ loading: false, error: err.message || 'Confirmation failed' })
      throw err
    }
  },

  clearError: () => set({ error: null }),
  clearNeedsConfirmation: () => set({ needsConfirmation: false }),

  signOut: () => {
    cognitoSignOut()
    set({ isAuthenticated: false, email: null, userId: null, role: null, error: null, needsConfirmation: false, pendingEmail: null })
    // Reset the data stores too. Logout is an SPA navigate() (no page reload),
    // so these in-memory stores otherwise survive across sessions — letting
    // admin-fetched control-plane data (from the unfiltered /admin endpoints)
    // leak into a subsequent user session. Resetting guarantees a clean slate
    // regardless of the prior role.
    useAdminStore.getState().reset()
    useUserStore.getState().reset()
    useChatStore.getState().reset()
  },

  checkSession: async () => {
    set({ loading: true })
    try {
      const session = await getSession()
      if (session?.isValid()) {
        const payload = session.getIdToken().payload
        const role = getRoleFromSession(session)
        set({
          isAuthenticated: true,
          email: payload.email as string,
          userId: payload.sub as string,
          role,
          loading: false,
          initialized: true,
        })
      } else {
        set({ isAuthenticated: false, loading: false, initialized: true })
      }
    } catch {
      set({ isAuthenticated: false, loading: false, initialized: true })
    }
  },
}))
