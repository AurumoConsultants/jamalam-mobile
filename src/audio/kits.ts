import * as Tone from 'tone'
import type { DrumPiece } from '../types'

export const KIT_NAMES = ['808', 'acoustic', 'lofi', 'techno'] as const
export type KitName = (typeof KIT_NAMES)[number]

export const DRUM_PIECES: DrumPiece[] = [
  'kick', 'snare', 'hihat', 'openhat', 'clap', 'tom', 'rim',
]

const DRUM_SET = new Set<string>(DRUM_PIECES)
export function isDrum(instrument: string): instrument is DrumPiece {
  return DRUM_SET.has(instrument)
}

// how long (seconds) to render each one-shot offline
const RENDER_SECONDS: Record<DrumPiece, number> = {
  kick: 1.2,
  snare: 0.4,
  hihat: 0.2,
  openhat: 0.6,
  clap: 0.4,
  tom: 0.6,
  rim: 0.15,
}

interface KitParams {
  kickNote: string
  kickPitchDecay: number
  kickOctaves: number
  kickDur: string
  snareToneHz: number
  snareNoise: 'white' | 'pink'
  snareDecay: number
  hatFreq: number
  hatDecay: number
  openDecay: number
  clapDecay: number
  tomNote: string
  lowpass: number | null
}

const KITS: Record<KitName, KitParams> = {
  '808': {
    kickNote: 'C1', kickPitchDecay: 0.1, kickOctaves: 8, kickDur: '2n',
    snareToneHz: 175, snareNoise: 'white', snareDecay: 0.2,
    hatFreq: 400, hatDecay: 0.05, openDecay: 0.35, clapDecay: 0.12,
    tomNote: 'G1', lowpass: null,
  },
  acoustic: {
    kickNote: 'C1', kickPitchDecay: 0.03, kickOctaves: 4, kickDur: '8n',
    snareToneHz: 200, snareNoise: 'white', snareDecay: 0.18,
    hatFreq: 350, hatDecay: 0.06, openDecay: 0.3, clapDecay: 0.14,
    tomNote: 'A1', lowpass: null,
  },
  lofi: {
    kickNote: 'C1', kickPitchDecay: 0.04, kickOctaves: 4, kickDur: '8n',
    snareToneHz: 190, snareNoise: 'pink', snareDecay: 0.16,
    hatFreq: 320, hatDecay: 0.05, openDecay: 0.26, clapDecay: 0.12,
    tomNote: 'A1', lowpass: 2600,
  },
  techno: {
    kickNote: 'C1', kickPitchDecay: 0.02, kickOctaves: 6, kickDur: '8n',
    snareToneHz: 210, snareNoise: 'white', snareDecay: 0.14,
    hatFreq: 450, hatDecay: 0.03, openDecay: 0.22, clapDecay: 0.1,
    tomNote: 'G1', lowpass: null,
  },
}

// output chain for one offline render (optionally through a lowpass for "lofi")
function makeOut(lowpass: number | null) {
  return lowpass ? new Tone.Filter(lowpass, 'lowpass').toDestination() : Tone.getDestination()
}

function renderPiece(p: KitParams, piece: DrumPiece) {
  const out = makeOut(p.lowpass)
  switch (piece) {
    case 'kick': {
      const k = new Tone.MembraneSynth({
        pitchDecay: p.kickPitchDecay,
        octaves: p.kickOctaves,
        envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.2 },
      }).connect(out)
      k.triggerAttackRelease(p.kickNote, p.kickDur, 0)
      break
    }
    case 'snare': {
      const noise = new Tone.NoiseSynth({
        noise: { type: p.snareNoise },
        envelope: { attack: 0.001, decay: p.snareDecay, sustain: 0 },
      }).connect(out)
      const body = new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.02 },
      }).connect(out)
      body.triggerAttackRelease(p.snareToneHz, 0.12, 0)
      noise.triggerAttackRelease(p.snareDecay, 0)
      break
    }
    case 'hihat':
    case 'openhat': {
      const decay = piece === 'hihat' ? p.hatDecay : p.openDecay
      const m = new Tone.MetalSynth({
        frequency: p.hatFreq,
        envelope: { attack: 0.001, decay, release: 0.02 },
        harmonicity: 5.1,
        modulationIndex: 32,
        resonance: 4000,
        octaves: 1.5,
      } as any).connect(out)
      m.triggerAttackRelease(decay, 0)
      break
    }
    case 'clap': {
      const bp = new Tone.Filter(1200, 'bandpass').connect(out)
      const n = new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.001, decay: 0.05, sustain: 0 },
      }).connect(bp)
      ;[0, 0.01, 0.02].forEach((t) => n.triggerAttackRelease(0.04, t))
      n.triggerAttackRelease(p.clapDecay, 0.03)
      break
    }
    case 'tom': {
      const k = new Tone.MembraneSynth({
        pitchDecay: 0.05,
        octaves: 3,
        envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.2 },
      }).connect(out)
      k.triggerAttackRelease(p.tomNote, '8n', 0)
      break
    }
    case 'rim': {
      const m = new Tone.MetalSynth({
        frequency: 800,
        envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
        harmonicity: 12,
        modulationIndex: 20,
        resonance: 3000,
        octaves: 1,
      } as any).connect(out)
      m.triggerAttackRelease(0.05, 0)
      break
    }
  }
}

class KitLibrary {
  private cache = new Map<string, Map<DrumPiece, Tone.ToneAudioBuffer>>()
  private pending = new Map<string, Promise<void>>()

  async ensure(name: string): Promise<void> {
    if (this.cache.has(name)) return
    if (this.pending.has(name)) return this.pending.get(name)
    const params = KITS[name as KitName]
    if (!params) return
    const job = (async () => {
      const pieces = new Map<DrumPiece, Tone.ToneAudioBuffer>()
      for (const piece of DRUM_PIECES) {
        const buf = await Tone.Offline(() => {
          renderPiece(params, piece)
        }, RENDER_SECONDS[piece])
        pieces.set(piece, buf as unknown as Tone.ToneAudioBuffer)
      }
      this.cache.set(name, pieces)
      this.pending.delete(name)
    })()
    this.pending.set(name, job)
    return job
  }

  get(name: string, piece: DrumPiece): Tone.ToneAudioBuffer | undefined {
    return this.cache.get(name)?.get(piece)
  }
}

export const kits = new KitLibrary()
