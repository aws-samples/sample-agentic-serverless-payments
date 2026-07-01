import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { PrivyProvider } from '@/providers/PrivyProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <PrivyProvider>
        <App />
      </PrivyProvider>
    </BrowserRouter>
  </StrictMode>,
)
