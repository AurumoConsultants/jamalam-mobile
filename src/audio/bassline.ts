// Hum/sing -> bass track. Pure DSP:
//   1. YIN pitch detection per frame (robust for the low, sustained voice)
//   2. an energy gate + median smoothing to drop unvoiced/noisy frames
//   3. segment consecutive same-pitch frames into notes
//   4. octave-shift the whole line into the bass register
//   5. QUANTIZE note starts/lengths to a 16th grid (shared with the drum tempo)
// Shares the beat grid with beatbox.ts so a bass part lines up with the drums.

export interface BassNote {
  start: number // beats (4/4), quantized
  duration: number // beats
  pitch: string // e.g. "C2"
  velocity: number // 0..1
}
export interface RawBassNote {
  time: number // seconds (un-quantized)
  dur: number // seconds
  midi: number // already octave-shifted into the bass register
  velocity: number
}
export interface BasslineResult {
  bpm: number
  bars: number
  notes: BassNote[]
  raw: RawBassNote[]
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function midiToName(m: number): string {
  const r = Math.round(m)
  const name = NOTE_NAMES[((r % 12) + 12) % 12]
  const oct = Math.floor(r / 12) - 1
  return `${name}${oct}`
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
}

// YIN fundamental-frequency estimate for one frame (0 = unvoiced)
function yin(frame: Float32Array, sampleRate: number, tauMin: number, tauMax: number, thresh = 0.15): number {
  const W = Math.min(frame.length - tauMax, frame.length >> 1)
  if (W <= 0) return 0
  const diff = new Float32Array(tauMax + 1)
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let s = 0
    for (let j = 0; j < W; j++) {
      const d = frame[j] - frame[j + tau]
      s += d * d
    }
    diff[tau] = s
  }
  // cumulative mean normalized difference
  const cmnd = new Float32Array(tauMax + 1)
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau]
    cmnd[tau] = tau < tauMin ? 1 : running > 0 ? (diff[tau] * tau) / running : 1
  }
  let tauEst = -1
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < thresh) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++
      tauEst = tau
      break
    }
  }
  if (tauEst < 0) return 0
  // parabolic interpolation around the trough
  const x0 = tauEst > tauMin ? cmnd[tauEst - 1] : cmnd[tauEst]
  const x2 = tauEst + 1 <= tauMax ? cmnd[tauEst + 1] : cmnd[tauEst]
  const a = x0 + x2 - 2 * cmnd[tauEst]
  const b = (x2 - x0) / 2
  const adj = a ? Math.max(-1, Math.min(1, -b / a)) : 0
  return sampleRate / (tauEst + adj)
}

function chooseBars(lastBeat: number): number {
  const need = lastBeat + 0.01
  for (const b of [1, 2, 4, 8, 16]) if (b * 4 >= need) return b
  return Math.ceil(need / 4)
}

// tempo guess from note spacing when there is no drum tempo to lock onto
function estimateBassTempo(raw: RawBassNote[]): number {
  if (raw.length < 2) return 100
  const iois: number[] = []
  for (let i = 1; i < raw.length; i++) iois.push(raw[i].time - raw[i - 1].time)
  iois.sort((a, b) => a - b)
  const med = iois[iois.length >> 1]
  if (med <= 0) return 100
  let bpm = 60 / med // assume ~one note per beat
  while (bpm < 70) bpm *= 2
  while (bpm > 170) bpm /= 2
  return Math.round(bpm)
}

/** Snap raw (seconds) bass notes to a 16th grid at bpm; optional fixed bar count. */
export function requantizeBass(raw: RawBassNote[], bpm: number, barsOpt?: number): { bars: number; notes: BassNote[] } {
  if (!raw.length) return { bars: barsOpt ?? 1, notes: [] }
  const sixteenth = 60 / bpm / 4
  const t0 = raw[0].time
  const notes: BassNote[] = raw.map((n) => {
    const start = Math.max(0, Math.round((n.time - t0) / sixteenth) * 0.25)
    let duration = Math.round(n.dur / sixteenth) * 0.25
    if (duration < 0.25) duration = 0.25
    return { start, duration, pitch: midiToName(n.midi), velocity: Math.round(n.velocity * 100) / 100 }
  })
  notes.sort((a, b) => a.start - b.start)
  // don't let a note overrun the next one
  for (let i = 0; i < notes.length - 1; i++) {
    const gap = notes[i + 1].start - notes[i].start
    if (gap > 0 && notes[i].duration > gap) notes[i].duration = gap
  }
  const last = notes[notes.length - 1]
  const lastBeat = last.start + last.duration
  return { bars: barsOpt ?? chooseBars(lastBeat), notes }
}

/** Analyze a mono buffer of humming/singing into a quantized bassline. */
export function analyzeBasslineSamples(
  x: Float32Array,
  sampleRate: number,
  opts?: { bpm?: number; bars?: number },
): BasslineResult {
  const N = 2048
  const H = 512
  const minF = 55
  const maxF = 500
  const tauMin = Math.max(2, Math.floor(sampleRate / maxF))
  const tauMax = Math.min(N - 1, Math.ceil(sampleRate / minF))
  const nFrames = Math.max(0, Math.floor((x.length - N) / H))
  const frameSec = H / sampleRate

  const midi = new Float32Array(nFrames) // 0 = unvoiced
  const energy = new Float32Array(nFrames)
  let maxE = 1e-9
  const frame = new Float32Array(N)

  for (let f = 0; f < nFrames; f++) {
    const off = f * H
    let e = 0
    for (let i = 0; i < N; i++) {
      const s = x[off + i]
      frame[i] = s
      e += s * s
    }
    e = Math.sqrt(e / N)
    energy[f] = e
    if (e > maxE) maxE = e
    if (e < 0.004) {
      midi[f] = 0
      continue
    }
    const hz = yin(frame, sampleRate, tauMin, tauMax)
    midi[f] = hz > 0 ? 69 + 12 * Math.log2(hz / 440) : 0
  }

  // median-filter the pitch track to kill single-frame octave blips
  const sm = new Float32Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    sm[f] = median3(midi[Math.max(0, f - 1)], midi[f], midi[Math.min(nFrames - 1, f + 1)])
  }

  const gate = 0.12 * maxE
  const rawNotes: RawBassNote[] = []
  let curStart = -1
  let curPitches: number[] = []
  let curVelSum = 0
  let curVelN = 0
  const flush = (endF: number) => {
    if (curStart >= 0 && curPitches.length) {
      const sorted = [...curPitches].sort((a, b) => a - b)
      const med = sorted[sorted.length >> 1]
      const durSec = (endF - curStart) * frameSec
      if (durSec >= 0.07) {
        rawNotes.push({
          time: curStart * frameSec,
          dur: durSec,
          midi: med,
          velocity: Math.max(0.4, Math.min(1, 0.5 + 0.5 * (curVelN ? curVelSum / curVelN / maxE : 0))),
        })
      }
    }
    curStart = -1
    curPitches = []
    curVelSum = 0
    curVelN = 0
  }

  for (let f = 0; f < nFrames; f++) {
    const voiced = sm[f] > 0 && energy[f] >= gate
    if (!voiced) {
      flush(f)
      continue
    }
    if (curStart < 0) {
      curStart = f
      curPitches = [sm[f]]
    } else if (Math.abs(sm[f] - curPitches[curPitches.length - 1]) > 1.2) {
      // pitch jumped >~1 semitone -> new note
      flush(f)
      curStart = f
      curPitches = [sm[f]]
    } else {
      curPitches.push(sm[f])
    }
    curVelSum += energy[f]
    curVelN++
  }
  flush(nFrames)

  if (!rawNotes.length) return { bpm: opts?.bpm ?? 100, bars: opts?.bars ?? 1, notes: [], raw: [] }

  // shift the whole line into the bass register (median -> ~C2 = MIDI 36)
  const meds = rawNotes.map((n) => n.midi).sort((a, b) => a - b)
  const medianMidi = meds[meds.length >> 1]
  const shift = 12 * Math.round((36 - medianMidi) / 12)
  for (const n of rawNotes) n.midi += shift

  const bpm = opts?.bpm ?? estimateBassTempo(rawNotes)
  const rq = requantizeBass(rawNotes, bpm, opts?.bars)
  return { bpm, bars: rq.bars, notes: rq.notes, raw: rawNotes }
}

export function analyzeBassline(buffer: AudioBuffer, opts?: { bpm?: number; bars?: number }): BasslineResult {
  return analyzeBasslineSamples(buffer.getChannelData(0), buffer.sampleRate, opts)
}
