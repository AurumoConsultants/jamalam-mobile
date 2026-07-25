import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'se.aurumo.jamalam',
  appName: 'Jamalam',
  webDir: 'dist',
  android: {
    // getUserMedia needs a secure context — Capacitor serves the app over
    // https://localhost, which qualifies.
    allowMixedContent: false,
  },
  plugins: {
    CapacitorUpdater: {
      // we drive update checks manually (see src/updater.ts), not Capgo's cloud
      autoUpdate: false,
    },
  },
}

export default config
