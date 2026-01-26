import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@base-org/account']
  },
  esbuild: {
    target: 'es2022'
  },
  define: {
    global: 'globalThis'
  },
  resolve: {
    alias: {
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      util: 'util'
    }
  },
  build: {
    rollupOptions: {
      external: ['@safe-globalThis/safe-apps-sdk', '@safe-globalThis/safe-apps-provider']
    }
  }
})