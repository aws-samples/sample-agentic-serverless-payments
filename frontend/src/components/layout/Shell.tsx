import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'

export function Shell() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-60 flex-1 p-6">
        <Outlet />
      </main>
    </div>
  )
}
