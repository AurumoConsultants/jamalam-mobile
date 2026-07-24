// Beatbox → drums (after-the-fact analysis). Pure DSP: onset detection via
// spectral flux, per-hit spectral classification (kick/snare/hihat), and a
// tempo estimate from the onset envelope. This is the seed of the shared core.

export type DrumType = 'kick' | 'snare' | 'hihat'
export interface Hit {
  time: number // seconds
  type: DrumType
  velocity: number // 0..1
}
export interface BeatboxResult {
  bpm: number
  hits: Hit[]
  durationSec: number
}

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
  // kick: energy concentrated low + dark timbre
  if (lowFrac > 0.12 && centroid < 1500) return 'kick'
  // hihat: bright AND thin — lots of high energy, little low-mid body
  if (highFrac > 0.32 && midFrac < 0.18) return 'hihat'
  // snare and everything else: has low-mid body (broadband)
  return 'snare'
}

function peakPick(flux: Float32Array, frameSec: number): number[] {
  const n = flux.length
  if (!n) return []
  let mx = 0
  for (let i = 0; i < n; i++) if (flux[i] > mx) mx = flux[i]
  if (mx < 1e-9) return []
  const norm = new Float32Array(n)
  for (let i = 0; i < n; i++) norm[i] = flux[i] / mx

  const w = 8 // local-mean window
  const minGap = Math.max(1, Math.round(0.07 / frameSec)) // 70 ms min between hits
  const delta = 0.06
  const out: number[] = []
  let last = -1e9
  for (let i = 1; i < n - 1; i++) {
    if (norm[i] < norm[i - 1] || norm[i] < norm[i + 1]) continue // local max only
    let sum = 0
    let cnt = 0
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      sum += norm[j]
      cnt++
    }
    const thr = sum / cnt + delta
    if (norm[i] >= thr && norm[i] > 0.1 && i - last >= minGap) {
      out.push(i)
      last = i
    }
  }
  return out
}

function estimateTempo(flux: Float32Array, frameSec: number): number {
  const n = flux.length
  if (n < 20) return 120
  let mean = 0
  for (let i = 0; i < n; i++) mean += flux[i]
  mean /= n
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) env[i] = Math.max(0, flux[i] - mean)

  const lagMin = Math.round(60 / 180 / frameSec) // 180 BPM
  const lagMax = Math.round(60 / 70 / frameSec) // 70 BPM
  let bestLag = 0
  let bestVal = 0
  for (let lag = lagMin; lag <= lagMax && lag < n; lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag]
    if (s > bestVal) {
      bestVal = s
      bestLag = lag
    }
  }
  if (!bestLag) return 120
  let bpm = 60 / (bestLag * frameSec)
  while (bpm < 70) bpm *= 2
  while (bpm > 180) bpm /= 2
  return Math.round(bpm)
}

/** Analyze a mono sample buffer. Exposed separately so it's testable without an AudioBuffer. */
export function analyzeSamples(x: Float32Array, sampleRate: number): BeatboxResult {
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
  const onsets = peakPick(flux, frameSec)
  const bpm = estimateTempo(flux, frameSec)

  let maxLoud = 1e-9
  for (const fi of onsets) if (loud[fi] > maxLoud) maxLoud = loud[fi]

  const hits: Hit[] = onsets.map((fi) => {
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
    c /= cnt
    lo /= cnt
    md /= cnt
    hi /= cnt
    return {
      time: fi * frameSec,
      type: classify(c, lo, md, hi),
      velocity: Math.max(0.35, Math.min(1, 0.4 + 0.6 * (pk / maxLoud))),
    }
  })

  return { bpm, hits, durationSec: x.length / sampleRate }
}

export function analyzeBeatbox(buffer: AudioBuffer): BeatboxResult {
  return analyzeSamples(buffer.getChannelData(0), buffer.sampleRate)
}
