import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // relative base so assets resolve under Capacitor's local origin
  base: './',
  plugins: [react()],
  server: { host: true },
})
