// Beatbox → drums (after-the-fact analysis). Pure DSP:
//   1. onset detection (spectral flux + peak-pick)
//   2. an energy gate to drop weak/breath/noise onsets
//   3. per-hit spectral classification (kick / snare / hihat)
//   4. tempo estimate (weighted autocorrelation, biased to musical tempos)
//   5. QUANTIZE each hit to a 16th-note grid + a clean whole-bar loop
// This is the seed of the shared core.

export type DrumType = 'kick' | 'snare' | 'hihat' | 'openhat'
export interface Hit {
  beat: number // quantized start, in beats (4/4)
  type: DrumType
  velocity: number // 0..1
}
export interface RawHit {
  time: number // seconds (un-quantized)
  type: DrumType
  velocity: number
}
export interface BeatboxResult {
  bpm: number
  bars: number
  hits: Hit[]
  raw: RawHit[] // pre-quantization, so the tempo can be changed without re-recording
}

// A per-sound spectral fingerprint. The calibration wizard records the user
// making each drum sound and stores the averaged fingerprint; analysis then
// classifies each onset by nearest fingerprint instead of fixed thresholds.
export interface FeatureVec {
  centroid: number // spectral centroid (Hz) — brightness
  lowFrac: number // fraction of energy < 150 Hz
  midFrac: number // fraction 150–2000 Hz
  highFrac: number // fraction > 6000 Hz
  decay: number // seconds the hit stays loud — separates closed vs open hats
}
export type DrumProfile = Partial<Record<DrumType, FeatureVec>>

function hann(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

// in-place iterative radix-2 FFT (n must be a power of two)
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k
        const b = a + (len >> 1)
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

function classify(centroid: number, lowFrac: number, midFrac: number, highFrac: number): DrumType {
  // Phone mics roll off deep bass, so don't *require* sub-150Hz energy for a kick.
  // Discriminate mainly by spectral centroid (brightness), which survives the roll-off.
  if (centroid > 3600 && midFrac < 0.28 && highFrac > 0.2) return 'hihat' // bright + thin = ts/tss
  if (centroid < 1200 || lowFrac > 0.1) return 'kick' // dark thump = b/p (even high-passed)
  return 'snare' // broadband mid = k/psh
}

function peakPick(flux: Float32Array, frameSec: number): number[] {
  const n = flux.length
  if (!n) return []
  let mx = 0
  for (let i = 0; i < n; i++) if (flux[i] > mx) mx = flux[i]
  if (mx < 1e-9) return []
  const norm = new Float32Array(n)
  for (let i = 0; i < n; i++) norm[i] = flux[i] / mx

  const w = 10 // local-mean window
  const minGap = Math.max(1, Math.round(0.09 / frameSec)) // 90 ms min between hits
  const delta = 0.08
  const out: number[] = []
  let last = -1e9
  for (let i = 1; i < n - 1; i++) {
    if (norm[i] < norm[i - 1] || norm[i] < norm[i + 1]) continue
    let sum = 0
    let cnt = 0
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      sum += norm[j]
      cnt++
    }
    const thr = sum / cnt + delta
    if (norm[i] >= thr && norm[i] > 0.15 && i - last >= minGap) {
      out.push(i)
      last = i
    }
  }
  return out
}

// Tempo via autocorrelation of the onset envelope, weighted toward musical
// tempos so it doesn't lock onto a half/double octave.
function estimateTempo(flux: Float32Array, frameSec: number): number {
  const n = flux.length
  if (n < 20) return 100
  let mean = 0
  for (let i = 0; i < n; i++) mean += flux[i]
  mean /= n
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) env[i] = Math.max(0, flux[i] - mean)

  const lagMin = Math.round(60 / 200 / frameSec) // 200 BPM
  const lagMax = Math.round(60 / 60 / frameSec) // 60 BPM
  let bestLag = 0
  let bestScore = 0
  for (let lag = lagMin; lag <= lagMax && lag < n; lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag]
    const bpm = 60 / (lag * frameSec)
    // log-normal preference centred on ~105 BPM
    const wt = Math.exp(-0.5 * Math.pow(Math.log(bpm / 105) / 0.4, 2))
    const score = s * wt
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (!bestLag) return 100
  return Math.round(60 / (bestLag * frameSec))
}

// nearest musical loop length (whole bars, power-of-two) that covers the phrase
function chooseBars(lastBeat: number): number {
  const need = lastBeat + 0.25
  for (const b of [1, 2, 4, 8, 16]) if (b * 4 >= need) return b
  return Math.ceil(need / 4)
}

interface OnsetFeat extends FeatureVec {
  time: number
  loud: number
}

/** FFT frames -> peak-picked, energy-gated onsets with a spectral fingerprint each. */
function detectOnsets(
  x: Float32Array,
  sampleRate: number,
): { onsets: OnsetFeat[]; flux: Float32Array; frameSec: number } {
  const N = 1024
  const H = 256
  const half = N >> 1
  const win = hann(N)
  const nFrames = Math.max(0, Math.floor((x.length - N) / H))

  const flux = new Float32Array(nFrames)
  const centroid = new Float32Array(nFrames)
  const lowFrac = new Float32Array(nFrames)
  const midFrac = new Float32Array(nFrames)
  const highFrac = new Float32Array(nFrames)
  const loud = new Float32Array(nFrames)
  const re = new Float32Array(N)
  const im = new Float32Array(N)
  const prev = new Float32Array(half)

  for (let f = 0; f < nFrames; f++) {
    const off = f * H
    for (let k = 0; k < N; k++) {
      re[k] = x[off + k] * win[k]
      im[k] = 0
    }
    fft(re, im)
    let sflux = 0
    let magSum = 0
    let cw = 0
    let low = 0
    let mid = 0
    let high = 0
    let energy = 0
    for (let k = 0; k < half; k++) {
      const mag = Math.hypot(re[k], im[k])
      const freq = (k * sampleRate) / N
      const d = mag - prev[k]
      if (d > 0) sflux += d
      prev[k] = mag
      magSum += mag
      cw += freq * mag
      energy += mag * mag
      if (freq < 150) low += mag
      else if (freq < 2000) mid += mag
      else if (freq > 6000) high += mag
    }
    flux[f] = sflux
    centroid[f] = magSum > 1e-9 ? cw / magSum : 0
    lowFrac[f] = magSum > 1e-9 ? low / magSum : 0
    midFrac[f] = magSum > 1e-9 ? mid / magSum : 0
    highFrac[f] = magSum > 1e-9 ? high / magSum : 0
    loud[f] = Math.sqrt(energy)
  }

  const frameSec = H / sampleRate
  const onsetFrames = peakPick(flux, frameSec)

  const raw: OnsetFeat[] = onsetFrames.map((fi) => {
    const a = fi
    const b = Math.min(nFrames - 1, fi + 3)
    let c = 0
    let lo = 0
    let md = 0
    let hi = 0
    let pk = 0
    let cnt = 0
    for (let f = a; f <= b; f++) {
      c += centroid[f]
      lo += lowFrac[f]
      md += midFrac[f]
      hi += highFrac[f]
      if (loud[f] > pk) pk = loud[f]
      cnt++
    }
    // decay: how long (s) the hit stays above 30% of its peak — open hats ring longer
    let decayFrames = 0
    const maxWin = Math.min(nFrames, fi + 120)
    for (let f = fi; f < maxWin; f++) {
      if (loud[f] >= 0.3 * pk) decayFrames = f - fi
      else if (f - fi > 2) break
    }
    return {
      time: fi * frameSec,
      centroid: c / cnt,
      lowFrac: lo / cnt,
      midFrac: md / cnt,
      highFrac: hi / cnt,
      decay: decayFrames * frameSec,
      loud: pk,
    }
  })

  // energy gate: drop weak onsets (breath, room noise, mouth clicks)
  let maxLoud = 1e-9
  for (const o of raw) if (o.loud > maxLoud) maxLoud = o.loud
  const onsets = raw.filter((o) => o.loud >= 0.13 * maxLoud)
  return { onsets, flux, frameSec }
}

// weighted distance between fingerprints (centroid in Hz is scaled down; decay
// and the energy fractions are already 0..1-ish and weighted up)
function featureDist(a: FeatureVec, b: FeatureVec): number {
  const dc = (a.centroid - b.centroid) / 3000
  const dl = (a.lowFrac - b.lowFrac) * 3
  const dm = (a.midFrac - b.midFrac) * 2
  const dh = (a.highFrac - b.highFrac) * 3
  const dd = (a.decay - b.decay) * 8
  return dc * dc + dl * dl + dm * dm + dh * dh + dd * dd
}

export function profileTypeCount(p: DrumProfile | undefined): number {
  return p ? Object.keys(p).length : 0
}

/** Classify one onset by nearest calibrated fingerprint. */
export function classifyWithProfile(f: FeatureVec, profile: DrumProfile): DrumType {
  let best: DrumType | null = null
  let bestD = Infinity
  for (const t of Object.keys(profile) as DrumType[]) {
    const p = profile[t]
    if (!p) continue
    const d = featureDist(f, p)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best ?? 'snare'
}

/**
 * Analyze a mono sample buffer. Testable without an AudioBuffer.
 * Pass a calibrated `profile` (>=2 sounds) to classify by the user's own
 * fingerprints; otherwise it falls back to the generic heuristic.
 */
export function analyzeSamples(x: Float32Array, sampleRate: number, profile?: DrumProfile): BeatboxResult {
  const { onsets, flux, frameSec } = detectOnsets(x, sampleRate)
  if (!onsets.length) return { bpm: 100, bars: 1, hits: [], raw: [] }

  let maxLoud = 1e-9
  for (const o of onsets) if (o.loud > maxLoud) maxLoud = o.loud

  const useProfile = profileTypeCount(profile) >= 2
  const bpm = estimateTempo(flux, frameSec)
  const classified: RawHit[] = onsets.map((o) => ({
    time: o.time,
    type: useProfile
      ? classifyWithProfile(o, profile as DrumProfile)
      : classify(o.centroid, o.lowFrac, o.midFrac, o.highFrac),
    velocity: Math.max(0.4, Math.min(1, 0.45 + 0.55 * (o.loud / maxLoud))),
  }))

  const { bars, hits } = requantize(classified, bpm)
  return { bpm, bars, hits, raw: classified }
}

/** Average the loudest onsets of a single-sound recording into one fingerprint (for calibration). */
export function profileFromSamples(x: Float32Array, sampleRate: number): FeatureVec | null {
  const { onsets } = detectOnsets(x, sampleRate)
  if (!onsets.length) return null
  const top = [...onsets].sort((a, b) => b.loud - a.loud).slice(0, 8)
  const n = top.length
  const avg = (sel: (o: OnsetFeat) => number) => top.reduce((s, o) => s + sel(o), 0) / n
  return {
    centroid: avg((o) => o.centroid),
    lowFrac: avg((o) => o.lowFrac),
    midFrac: avg((o) => o.midFrac),
    highFrac: avg((o) => o.highFrac),
    decay: avg((o) => o.decay),
  }
}

export function profileFromBuffer(buffer: AudioBuffer): FeatureVec | null {
  return profileFromSamples(buffer.getChannelData(0), buffer.sampleRate)
}

/** Snap already-classified onsets to a 16th grid at a given tempo (used for ½×/2× tempo nudges). */
export function requantize(raw: RawHit[], bpm: number): { bars: number; hits: Hit[] } {
  if (!raw.length) return { bars: 1, hits: [] }
  const sixteenthSec = 60 / bpm / 4
  const t0 = raw[0].time // anchor the grid to the first hit
  const byKey = new Map<string, Hit>()
  for (const o of raw) {
    const beat = Math.max(0, Math.round((o.time - t0) / sixteenthSec) * 0.25)
    const key = `${o.type}@${beat}`
    const ex = byKey.get(key)
    if (!ex || o.velocity > ex.velocity) byKey.set(key, { beat, type: o.type, velocity: o.velocity })
  }
  const hits = [...byKey.values()].sort((a, b) => a.beat - b.beat)
  const lastBeat = hits.length ? hits[hits.length - 1].beat : 0
  return { bars: chooseBars(lastBeat), hits }
}

export function analyzeBeatbox(buffer: AudioBuffer, profile?: DrumProfile): BeatboxResult {
  return analyzeSamples(buffer.getChannelData(0), buffer.sampleRate, profile)
}
