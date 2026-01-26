import { createAppKit } from '@reown/appkit/react'
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { base, baseSepolia } from 'wagmi/chains'

export const projectId = import.meta.env.VITE_PAYER_WALLETCONNECT_PROJECT_ID 

const metadata = {
  name: 'AI Content Monetization',
  description: 'AI Content Monetization Platform',
  url: 'http://localhost:5174',
  icons: ['https://avatars.githubusercontent.com/u/37784886']
}

const networks = [base, baseSepolia]

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId
})

export const config = wagmiAdapter.wagmiConfig

createAppKit({
  adapters: [wagmiAdapter],
  networks: [base, baseSepolia],
  projectId,
  metadata,
  features: {
    analytics: true
  }
})