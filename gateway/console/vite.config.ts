import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Console for the ArcGateway app. Built locally into ../public and served by server.js (no build step
// on Databricks Apps). `npm run console:dev` proxies /api and /databricks to a gateway for local work.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL('../public', import.meta.url)), emptyOutDir: true, sourcemap: false },
  server: {
    port: 5180,
    proxy: process.env.GATEWAY_URL
      ? { '/api': { target: process.env.GATEWAY_URL, changeOrigin: true }, '/databricks': { target: process.env.GATEWAY_URL, changeOrigin: true } }
      : undefined
  }
})
