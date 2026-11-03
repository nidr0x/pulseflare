import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: {
    proxy: {
      '/api': process.env.PULSEFLARE_WORKER_URL || 'http://127.0.0.1:8787',
    },
  },
  test: {
    environment: 'node',
  },
})
