import * as Tone from 'tone'
import type { DrumPiece, InstrumentType, Note, Track } from '../types'
import { kits, isDrum } from './kits'

interface Voice {
  node: any | null // the Tone instrument (null for sampled drums)
  volume: Tone.Volume
  part: Tone.Part | null
  trigger: (pitch: string, durBBS: string, time: number, velocity: number) => void
  usesPitch: boolean
}

// beats (4/4) -> Tone "bars:beats:sixteenths" so events follow the tempo
function beatsToBBS(beats: number): string {
  const bar = Math.floor(beats / 4)
  const beat = Math.floor(beats) % 4
  const sixteenths = Math.round((beats - Math.floor(beats)) * 4 * 1000) / 1000
  return `${bar}:${beat}:${sixteenths}`
}

function makeSynth(type: InstrumentType): { node: any; trigger: Voice['trigger'] } {
  let node: any
  switch (type) {
    case 'fm':
      node = new Tone.PolySynth(Tone.FMSynth)
      break
    case 'am':
      node = new Tone.PolySynth(Tone.AMSynth)
      break
    case 'pluck':
      node = new Tone.PolySynth(Tone.Synth)
      node.set({ oscillator: { type: 'triangle' }, envelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.2 } })
      break
    case 'bass':
      node = new Tone.PolySynth(Tone.MonoSynth)
      node.set({ oscillator: { type: 'sawtooth' }, filter: { Q: 2 }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.3 } })
      break
    case 'pad':
      node = new Tone.PolySynth(Tone.Synth)
      node.set({ oscillator: { type: 'triangle' }, envelope: { attack: 0.6, decay: 0.3, sustain: 0.7, release: 1.2 } })
      break
    case 'synth':
    default:
      node = new Tone.PolySynth(Tone.Synth)
      break
  }
  const trigger: Voice['trigger'] = (pitch, durBBS, time, velocity) =>
    node.triggerAttackRelease(pitch, durBBS, time, velocity)
  return { node, trigger }
}

class Engine {
  private voices = new Map<string, Voice>()
  private started = false
  private loopBars = 4
  currentKit = '808'

  async ensureStarted() {
    if (!this.started) {
      await Tone.start()
      Tone.Transport.loop = true
      Tone.Transport.loopStart = 0
      Tone.Transport.loopEnd = `${this.loopBars}m`
      this.started = true
    }
    await kits.ensure(this.currentKit)
  }

  setKit(name: string) {
    this.currentKit = name
    kits.ensure(name)
  }

  private buildVoice(type: InstrumentType): Voice {
    const volume = new Tone.Volume(-6).toDestination()

    if (isDrum(type)) {
      const piece = type as DrumPiece
      kits.ensure(this.currentKit)
      const engine = this
      const trigger: Voice['trigger'] = (_pitch, _dur, time, velocity) => {
        const buf = kits.get(engine.currentKit, piece)
        if (!buf) return
        const g = new Tone.Gain(velocity).connect(volume)
        const src = new Tone.ToneBufferSource(buf).connect(g)
        src.onended = () => {
          try {
            src.dispose()
            g.dispose()
          } catch {
            // ignore
          }
        }
        src.start(time)
      }
      return { node: null, volume, part: null, trigger, usesPitch: false }
    }

    const { node, trigger } = makeSynth(type)
    node.connect(volume)
    return { node, volume, part: null, trigger, usesPitch: true }
  }

  setTempo(bpm: number) {
    Tone.Transport.bpm.value = Math.max(20, Math.min(300, bpm))
  }

  setLoopBars(bars: number) {
    this.loopBars = Math.max(1, Math.round(bars))
    Tone.Transport.loopEnd = `${this.loopBars}m`
  }

  addOrUpdateTrack(track: Track) {
    let voice = this.voices.get(track.id)
    if (!voice) {
      voice = this.buildVoice(track.instrument)
      this.voices.set(track.id, voice)
    }
    voice.volume.volume.value = track.volume
    voice.volume.mute = track.muted
    this.setNotes(track.id, track.notes)
  }

  setInstrument(track: Track) {
    const voice = this.voices.get(track.id)
    if (voice) {
      voice.part?.dispose()
      voice.node?.dispose?.()
      voice.volume.dispose()
      this.voices.delete(track.id)
    }
    this.addOrUpdateTrack(track)
  }

  removeTrack(id: string) {
    const voice = this.voices.get(id)
    if (!voice) return
    voice.part?.dispose()
    voice.node?.dispose?.()
    voice.volume.dispose()
    this.voices.delete(id)
  }

  setVolume(id: string, db: number) {
    const voice = this.voices.get(id)
    if (voice) voice.volume.volume.value = db
  }

  setMute(id: string, muted: boolean) {
    const voice = this.voices.get(id)
    if (voice) voice.volume.mute = muted
  }

  setNotes(id: string, notes: Note[]) {
    const voice = this.voices.get(id)
    if (!voice) return
    voice.part?.dispose()
    const events = notes.map((n) => ({
      time: beatsToBBS(n.start),
      pitch: n.pitch,
      dur: beatsToBBS(Math.max(0.05, n.duration)),
      velocity: n.velocity,
    }))
    const part = new Tone.Part((time, ev: any) => {
      voice.trigger(ev.pitch, ev.dur, time, ev.velocity)
    }, events as any)
    part.start(0)
    voice.part = part
  }

  // audition a single note immediately (used while editing in the piano roll)
  async previewNote(id: string, pitch: string, velocity = 0.8) {
    await this.ensureStarted()
    const voice = this.voices.get(id)
    if (!voice) return
    try {
      voice.trigger(pitch, '8n', Tone.now(), velocity)
    } catch {
      // ignore
    }
  }

  async play() {
    await this.ensureStarted()
    Tone.Transport.start()
  }

  stop() {
    Tone.Transport.stop()
  }

  progress(): number {
    return this.started ? Tone.Transport.progress : 0
  }

  isPlaying(): boolean {
    return Tone.Transport.state === 'started'
  }
}

export const engine = new Engine()
