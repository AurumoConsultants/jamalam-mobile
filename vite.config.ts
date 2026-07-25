import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // relative base so assets resolve under Capacitor's local origin
  base: './',
  plugins: [react()],
  server: { host: true },
  // the build number baked into this bundle; CI sets BUILD_NUMBER, dev = 0.
  // OTA compares this against the published manifest to decide whether to update.
  define: {
    __APP_BUILD__: JSON.stringify(process.env.BUILD_NUMBER ?? '0'),
  },
})
