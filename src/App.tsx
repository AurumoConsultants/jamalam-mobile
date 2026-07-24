import { useEffect, useRef, useState } from 'react'
import { engine } from './audio/engine'
import { KIT_NAMES } from './audio/kits'
import { analyzeBeatbox, type Hit } from './audio/beatbox'
import type { Track } from './types'

type Phase = 'idle' | 'recording' | 'analyzing' | 'ready'

const DRUMS: Array<[Hit['type'], string]> = [
  ['kick', 'Kick'],
  ['snare', 'Snare'],
  ['hihat', 'Hihat'],
]

let idc = 0
const newId = () => `t${Date.now().toString(36)}${idc++}`

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [kit, setKit] = useState('808')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ bpm: number; counts: Record<string, number>; total: number } | null>(null)

  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startRef = useRef(0)
  const rafRef = useRef(0)
  const bufRef = useRef<Float32Array>(new Float32Array(2048))
  const trackIdsRef = useRef<string[]>([])
  const kitRef = useRef('808')

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      try {
        streamRef.current?.getTracks().forEach((t) => t.stop())
      } catch {
        // ignore
      }
    }
  }, [])

  async function start() {
    setError(null)
    setResult(null)
    engine.ensureStarted().catch(() => {})
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      streamRef.current = stream
      const ctx = new AudioContext()
      ctxRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 2048
      analyserRef.current = an
      src.connect(an)

      const rec = new MediaRecorder(stream)
      recRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.onstop = onStopped
      rec.start()
      startRef.current = performance.now()
      setPhase('recording')

      const tick = () => {
        setElapsed(performance.now() - startRef.current)
        const a = analyserRef.current
        if (a) {
          a.getFloatTimeDomainData(bufRef.current as any)
          let p = 0
          for (const v of bufRef.current) {
            const abs = v < 0 ? -v : v
            if (abs > p) p = abs
          }
          setLevel(p)
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e: any) {
      setError(e?.message || 'Microphone not available. Grant mic permission and try again.')
      setPhase('idle')
    }
  }

  function stop() {
    if (recRef.current && phase === 'recording') {
      setPhase('analyzing')
      cancelAnimationFrame(rafRef.current)
      setLevel(0)
      recRef.current.stop()
    }
  }

  async function onStopped() {
    try {
      const blob = new Blob(chunksRef.current)
      const ctx = ctxRef.current ?? new AudioContext()
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer())
      streamRef.current?.getTracks().forEach((t) => t.stop())

      const { bpm, hits } = analyzeBeatbox(audio)
      if (!hits.length) {
        setError('No hits detected — beatbox a bit louder and closer to the mic.')
        setPhase('idle')
        return
      }
      await buildDrums(bpm, hits)
      const counts: Record<string, number> = {}
      for (const h of hits) counts[h.type] = (counts[h.type] || 0) + 1
      setResult({ bpm, counts, total: hits.length })
      setPlaying(true)
      setPhase('ready')
    } catch (e: any) {
      setError(e?.message || 'Could not analyze the recording.')
      setPhase('idle')
    }
  }

  async function buildDrums(bpm: number, hits: Hit[]) {
    trackIdsRef.current.forEach((id) => engine.removeTrack(id))
    trackIdsRef.current = []
    engine.setTempo(bpm)
    engine.setKit(kitRef.current)
    const spb = bpm / 60
    let maxBeat = 0
    for (const [type, name] of DRUMS) {
      const group = hits.filter((h) => h.type === type)
      if (!group.length) continue
      const notes = group.map((h) => {
        const start = Math.round(h.time * spb * 1000) / 1000
        if (start > maxBeat) maxBeat = start
        return { pitch: 'C2', start, duration: 0.25, velocity: Math.round(h.velocity * 100) / 100 }
      })
      const id = newId()
      const track: Track = { id, name, instrument: type, volume: -6, muted: false, notes }
      engine.addOrUpdateTrack(track)
      trackIdsRef.current.push(id)
    }
    engine.setLoopBars(Math.max(1, Math.ceil((maxBeat + 0.5) / 4)))
    await engine.play()
  }

  async function togglePlay() {
    if (engine.isPlaying()) {
      engine.stop()
      setPlaying(false)
    } else {
      await engine.play()
      setPlaying(true)
    }
  }

  function changeKit(name: string) {
    setKit(name)
    kitRef.current = name
    engine.setKit(name)
  }

  const meterScale = 1 + Math.min(0.35, level * 0.9)
  const recording = phase === 'recording'
  const analyzing = phase === 'analyzing'

  return (
    <div className="screen">
      <header className="top">
        <img className="logo" src="./brand/mark.png" alt="" />
        <div className="brand">
          Jamalam<span className="tag"> · beatbox → drums</span>
        </div>
      </header>

      <main className="stage">
        <p className="hint">
          {recording
            ? 'Listening… beatbox your groove'
            : analyzing
              ? 'Finding the hits…'
              : result
                ? 'Your beatbox, played by a real kit.'
                : 'Tap and beatbox — kicks, snares, hats. Jamalam turns it into drums.'}
        </p>

        <button
          className={`orb ${recording ? 'rec' : ''} ${analyzing ? 'busy' : ''}`}
          style={{ transform: `scale(${recording ? meterScale : 1})` }}
          onClick={recording ? stop : analyzing ? undefined : start}
          disabled={analyzing}
        >
          {recording ? '■' : analyzing ? '…' : '●'}
          <span className="orb-label">
            {recording ? fmt(elapsed) : analyzing ? 'converting' : result ? 'again' : 'beatbox'}
          </span>
        </button>

        {result && phase === 'ready' && (
          <div className="result">
            <div className="counts">
              {DRUMS.filter(([t]) => result.counts[t]).map(([t, n]) => (
                <span key={t} className={`chip ${t}`}>
                  {result.counts[t]} {n}
                </span>
              ))}
            </div>
            <div className="bpm">~{result.bpm} BPM</div>
            <button className="play" onClick={togglePlay}>
              {playing ? '■ Stop' : '▶ Play'}
            </button>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </main>

      <footer className="bottom">
        <label className="kit">
          Kit
          <select value={kit} onChange={(e) => changeKit(e.target.value)}>
            {KIT_NAMES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </footer>
    </div>
  )
}
