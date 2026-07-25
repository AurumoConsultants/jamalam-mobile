import type { DrumProfile } from './beatbox'

// The user's personal beatbox fingerprints, persisted locally.
const KEY = 'jamalam.drumProfile.v1'

export function loadProfile(): DrumProfile {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as DrumProfile
  } catch {
    return {}
  }
}

export function saveProfile(p: DrumProfile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // ignore (storage disabled)
  }
}

export function clearProfile(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
