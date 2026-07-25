// Over-the-air web self-update from GitHub (native only).
// The CI publishes a `latest.json` manifest + a zipped web bundle to the
// repo's `ota` release. On launch we compare the manifest's build number to
// the one baked into the running bundle (__APP_BUILD__) and, if newer,
// download the bundle. Applying it (reload) is left to the caller so the UI
// can offer a "tap to update" instead of yanking the app out from under you.

import { Capacitor } from '@capacitor/core'
import { CapacitorUpdater, type BundleInfo } from '@capgo/capacitor-updater'

const MANIFEST_URL =
  'https://github.com/AurumoConsultants/jamalam-mobile/releases/download/ota/latest.json'

export function currentBuild(): number {
  const n = Number(__APP_BUILD__)
  return Number.isFinite(n) ? n : 0
}

/** Tell the plugin the current bundle booted OK (prevents auto-rollback). */
export async function markLaunchOk(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    await CapacitorUpdater.notifyAppReady()
  } catch {
    // ignore
  }
}

/**
 * Check GitHub for a newer web bundle. If found, download it (does NOT apply).
 * Returns the downloaded bundle to hand to applyUpdate(), or null.
 */
export async function checkForWebUpdate(): Promise<{ bundle: BundleInfo; build: number } | null> {
  if (!Capacitor.isNativePlatform()) return null
  try {
    const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const manifest = (await res.json()) as { build?: number | string; url?: string }
    const build = Number(manifest.build)
    if (!manifest.url || !Number.isFinite(build) || build <= currentBuild()) return null

    const bundle = await CapacitorUpdater.download({
      url: manifest.url,
      version: `0.0.${build}`,
    })
    return { bundle, build }
  } catch {
    return null
  }
}

/** Switch to the downloaded bundle (reloads the web view into the new code). */
export async function applyUpdate(bundle: BundleInfo): Promise<void> {
  await CapacitorUpdater.set(bundle)
}
