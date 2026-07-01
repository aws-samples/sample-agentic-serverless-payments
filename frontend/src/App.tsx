import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Shell } from '@/components/layout/Shell'
import { useAuthStore } from '@/store/auth'
import { useAdminStore, useUserStore } from '@/store'
import * as api from '@/lib/api'
import { Login } from '@/pages/Login'

const AdminOverview = lazy(() => import('@/pages/admin/Overview').then(m => ({ default: m.AdminOverview })))
const CredentialProviders = lazy(() => import('@/pages/admin/CredentialProviders').then(m => ({ default: m.CredentialProviders })))
const PaymentManagers = lazy(() => import('@/pages/admin/PaymentManagers').then(m => ({ default: m.PaymentManagers })))
const PaymentConnectors = lazy(() => import('@/pages/admin/PaymentConnectors').then(m => ({ default: m.PaymentConnectors })))
const AdminHowItWorks = lazy(() => import('@/pages/admin/HowItWorks').then(m => ({ default: m.AdminHowItWorks })))
const SellerSetup = lazy(() => import('@/pages/admin/SellerSetup').then(m => ({ default: m.SellerSetup })))
const SellerOrders = lazy(() => import('@/pages/admin/SellerOrders').then(m => ({ default: m.SellerOrders })))
const Instruments = lazy(() => import('@/pages/user/Instruments').then(m => ({ default: m.Instruments })))
const ConnectAgent = lazy(() => import('@/pages/user/ConnectAgent').then(m => ({ default: m.ConnectAgent })))
const Sessions = lazy(() => import('@/pages/user/Sessions').then(m => ({ default: m.Sessions })))
const AgentChat = lazy(() => import('@/pages/user/AgentChat').then(m => ({ default: m.AgentChat })))
const Library = lazy(() => import('@/pages/user/Library').then(m => ({ default: m.Library })))
const Orders = lazy(() => import('@/pages/user/Orders').then(m => ({ default: m.Orders })))
const Information = lazy(() => import('@/pages/user/Information').then(m => ({ default: m.Information })))

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  )
}

export default function App() {
  const { isAuthenticated, initialized, role, checkSession } = useAuthStore()

  useEffect(() => { checkSession() }, [checkSession])

  const adminStore = useAdminStore()
  const userStore = useUserStore()

  // Prefetch data based on role
  useEffect(() => {
    if (!isAuthenticated || !role) return

    const isAdmin = role === 'admin'

    if (isAdmin && !adminStore._prefetched) {
      const prefetchAdmin = async () => {
        try {
          const [cpRes, mgRes] = await Promise.allSettled([
            api.listCredentialProviders(),
            api.listPaymentManagers(),
          ])

          if (cpRes.status === 'fulfilled')
            adminStore.setCredentialProviders(cpRes.value.credentialProviders || [])

          if (mgRes.status === 'fulfilled') {
            const managers = mgRes.value.paymentManagers || []
            adminStore.setPaymentManagers(managers)

            const connResults = await Promise.allSettled(
              managers.map((m: any) =>
                api.listPaymentConnectors(m.paymentManagerId)
                  .then(d => (d.paymentConnectors || []).map((c: any) => ({ ...c, paymentManagerId: m.paymentManagerId })))
              )
            )
            const allConnectors = connResults
              .filter((r): r is PromiseFulfilledResult<any[]> => r.status === 'fulfilled')
              .flatMap(r => r.value)
            adminStore.setPaymentConnectors(allConnectors)
          }
        } catch { /* best-effort */ }
        adminStore.markPrefetched()
      }
      prefetchAdmin()
    }

    if (!isAdmin && !userStore._prefetched) {
      const prefetchUser = async () => {
        try {
          // Tier 1 — bootstrap manager + connector options from the
          // user-scoped, read-only endpoint. Regular users CANNOT call the
          // admin /admin/managers route (403), so we use /user/payment-options
          // which returns only the non-sensitive identifiers needed to create
          // instruments and sessions.
          const optsRes = await api.getPaymentOptions().catch(() => null)
          const options = optsRes?.paymentOptions || []

          // Shape into the manager/connector records the pages already consume.
          const managers = options.map((o) => ({
            paymentManagerId: o.paymentManagerId,
            paymentManagerArn: o.paymentManagerArn,
            name: o.managerName,
            status: o.status,
          }))
          adminStore.setPaymentManagers(managers as any)

          const allConnectors = options.flatMap((o) =>
            (o.connectors || []).map((c) => ({
              paymentConnectorId: c.paymentConnectorId,
              paymentManagerId: o.paymentManagerId,
              name: c.connectorName,
              type: c.type,
              status: c.status,
            }))
          )
          adminStore.setPaymentConnectors(allConnectors as any)

          const managerArns = managers.map((m) => m.paymentManagerArn).filter(Boolean)

          // Tier 2 — the user's own instruments + sessions (scoped to their
          // Cognito sub by the backend). Independent, run in parallel.
          const [instrRes, sessRes] = await Promise.all([
            api.listAllInstruments(managerArns).catch(() => ({ paymentInstruments: [] })),
            api.listAllSessions(managerArns).catch(() => ({ paymentSessions: [] })),
          ])

          // ListPaymentInstruments returns IDs + status but NOT the wallet
          // address/network (those live only on GetPaymentInstrument). Enrich
          // each row with a parallel Get so the store carries full details for
          // every consumer (Instruments table, Agent Chat context).
          const listedInstruments = instrRes.paymentInstruments || []
          const enrichedInstruments = await Promise.all(
            listedInstruments.map(async (inst: any) => {
              const managerArn = inst.paymentManagerArn
              const connectorId = inst.paymentConnectorId
              if (!managerArn || !connectorId) return inst
              try {
                const full = await api.getInstrument(inst.paymentInstrumentId, { managerArn, connectorId })
                return { ...inst, ...(full.paymentInstrument || {}) }
              } catch {
                return inst
              }
            })
          )
          userStore.setInstruments(enrichedInstruments)
          userStore.setSessions(sessRes.paymentSessions || [])
        } catch { /* best-effort */ }
        userStore.markPrefetched()
      }
      prefetchUser()
    }
  }, [isAuthenticated, role])

  if (!initialized) return <PageLoader />
  if (!isAuthenticated) return <Login />

  const defaultPath = role === 'admin' ? '/admin' : '/user'

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<Shell />}>
          {/* Admin routes — only for admin role */}
          {role === 'admin' && (
            <>
              <Route path="/admin" element={<AdminOverview />} />
              <Route path="/admin/credential-providers" element={<CredentialProviders />} />
              <Route path="/admin/payment-managers" element={<PaymentManagers />} />
              <Route path="/admin/payment-connectors" element={<PaymentConnectors />} />
              <Route path="/admin/seller-setup" element={<SellerSetup />} />
              <Route path="/admin/seller-orders" element={<SellerOrders />} />
              <Route path="/admin/how-it-works" element={<AdminHowItWorks />} />
            </>
          )}

          {/* User routes — only for user role */}
          {role === 'user' && (
            <>
              <Route path="/user" element={<Instruments />} />
              <Route path="/user/connect-agent" element={<ConnectAgent />} />
              <Route path="/user/sessions" element={<Sessions />} />
              <Route path="/user/agent" element={<AgentChat />} />
              <Route path="/user/library" element={<Library />} />
              <Route path="/user/orders" element={<Orders />} />
              <Route path="/user/how-it-works" element={<Information />} />
            </>
          )}

          <Route path="/" element={<Navigate to={defaultPath} replace />} />
          <Route path="*" element={<Navigate to={defaultPath} replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
