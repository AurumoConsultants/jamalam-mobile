import { useEffect, useRef, useState } from 'react'
import { engine } from './audio/engine'
import { KIT_NAMES } from './audio/kits'
import { analyzeBeatbox, requantize, type Hit, type BeatboxResult } from './audio/beatbox'
import type { Track } from './types'
import { markLaunchOk, checkForWebUpdate, applyUpdate } from './updater'
import type { BundleInfo } from '@capgo/capacitor-updater'

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
  const [updateBundle, setUpdateBundle] = useState<BundleInfo | null>(null)
  const [applying, setApplying] = useState(false)
  const [checking, setChecking] = useState(false)

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
  const analysisRef = useRef<BeatboxResult | null>(null)
  const peakRef = useRef(0) // loudest input this take — detects a silent/blocked mic

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

  // check GitHub for a newer web bundle on launch
  useEffect(() => {
    markLaunchOk()
    checkForWebUpdate().then((r) => {
      if (r) setUpdateBundle(r.bundle)
    })
  }, [])

  async function manualCheck() {
    if (checking) return
    setChecking(true)
    const r = await checkForWebUpdate()
    setChecking(false)
    if (r) setUpdateBundle(r.bundle)
  }

  async function applyWebUpdate() {
    if (!updateBundle) return
    setApplying(true)
    try {
      await applyUpdate(updateBundle)
    } catch {
      setApplying(false)
    }
  }

  async function start() {
    setError(null)
    setResult(null)
    peakRef.current = 0
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
          if (p > peakRef.current) peakRef.current = p
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

      if (peakRef.current < 0.012) {
        setError('Mic captured silence — allow microphone access for Jamalam in your phone settings and try again.')
        setPhase('idle')
        return
      }

      const analysis = analyzeBeatbox(audio)
      if (!analysis.hits.length) {
        setError('No hits detected — beatbox a bit louder and closer to the mic.')
        setPhase('idle')
        return
      }
      analysisRef.current = analysis
      await buildDrums(analysis)
      const counts: Record<string, number> = {}
      for (const h of analysis.hits) counts[h.type] = (counts[h.type] || 0) + 1
      setResult({ bpm: analysis.bpm, counts, total: analysis.hits.length })
      setPlaying(true)
      setPhase('ready')
    } catch (e: any) {
      setError(e?.message || 'Could not analyze the recording.')
      setPhase('idle')
    }
  }

  async function buildDrums(a: BeatboxResult) {
    trackIdsRef.current.forEach((id) => engine.removeTrack(id))
    trackIdsRef.current = []
    engine.setTempo(a.bpm)
    engine.setKit(kitRef.current)
    for (const [type, name] of DRUMS) {
      const group = a.hits.filter((h) => h.type === type)
      if (!group.length) continue
      const notes = group.map((h) => ({
        pitch: 'C2',
        start: h.beat,
        duration: 0.25,
        velocity: Math.round(h.velocity * 100) / 100,
      }))
      const id = newId()
      const track: Track = { id, name, instrument: type, volume: -6, muted: false, notes }
      engine.addOrUpdateTrack(track)
      trackIdsRef.current.push(id)
    }
    engine.setLoopBars(a.bars)
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

  // re-quantize the same take at half / double tempo (fixes an octave-wrong grid)
  async function adjustTempo(factor: number) {
    const a = analysisRef.current
    if (!a) return
    const bpm = Math.max(50, Math.min(220, Math.round(a.bpm * factor)))
    const rq = requantize(a.raw, bpm)
    const next: BeatboxResult = { bpm, bars: rq.bars, hits: rq.hits, raw: a.raw }
    analysisRef.current = next
    await buildDrums(next)
    const counts: Record<string, number> = {}
    for (const h of rq.hits) counts[h.type] = (counts[h.type] || 0) + 1
    setResult({ bpm, counts, total: rq.hits.length })
    setPlaying(true)
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
            <div className="tempo">
              <button className="tempo-btn" onClick={() => adjustTempo(0.5)} title="Half tempo">
                ½×
              </button>
              <span className="bpm">~{result.bpm} BPM</span>
              <button className="tempo-btn" onClick={() => adjustTempo(2)} title="Double tempo">
                2×
              </button>
            </div>
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
        <button className="build" onClick={manualCheck} title="Tap to check for updates">
          build {__APP_BUILD__}
          {checking ? ' · checking…' : ''}
        </button>
      </footer>

      {updateBundle && (
        <button className="ota" onClick={applyWebUpdate} disabled={applying}>
          {applying ? 'Updating…' : '✨ New version ready — tap to update'}
        </button>
      )}
    </div>
  )
}
