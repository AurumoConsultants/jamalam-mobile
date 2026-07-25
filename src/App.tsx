import { useEffect, useRef, useState } from 'react'
import { engine } from './audio/engine'
import { KIT_NAMES } from './audio/kits'
import { analyzeBeatbox, requantize, type Hit, type BeatboxResult } from './audio/beatbox'
import { loadProfile } from './audio/profile'
import Calibrate from './Calibrate'
import type { DrumProfile } from './audio/beatbox'
import type { Track } from './types'
import { markLaunchOk, checkForWebUpdate, applyUpdate } from './updater'
import type { BundleInfo } from '@capgo/capacitor-updater'

type Phase = 'idle' | 'recording' | 'analyzing' | 'ready'

const DRUMS: Array<[Hit['type'], string]> = [
  ['kick', 'Kick'],
  ['snare', 'Snare'],
  ['hihat', 'Hihat'],
  ['openhat', 'Open Hat'],
]
const LABELS: Record<string, string> = { kick: 'Kick', snare: 'Snare', hihat: 'Hi-hat', openhat: 'Open hat' }

// a committed part = its own drum track(s) that keep looping
interface Layer {
  id: string
  name: string
  trackIds: string[]
  muted: boolean
}

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
  const [layers, setLayers] = useState<Layer[]>([])
  const [updateBundle, setUpdateBundle] = useState<BundleInfo | null>(null)
  const [applying, setApplying] = useState(false)
  const [checking, setChecking] = useState(false)
  const [showCalib, setShowCalib] = useState(false)
  const [profile, setProfile] = useState<DrumProfile>({})

  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startRef = useRef(0)
  const rafRef = useRef(0)
  const bufRef = useRef<Float32Array>(new Float32Array(2048))
  const previewIdsRef = useRef<string[]>([]) // the un-committed take's tracks
  const kitRef = useRef('808')
  const analysisRef = useRef<BeatboxResult | null>(null)
  const peakRef = useRef(0)
  const sessionBpmRef = useRef<number | null>(null) // locked once the first part is kept
  const sessionBarsRef = useRef<number | null>(null)

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

  useEffect(() => setProfile(loadProfile()), [])

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
      // when overdubbing (a loop is already playing), turn on echo cancellation
      // to keep the looping speaker sound out of the new recording
      const overdub = layers.length > 0
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: overdub, noiseSuppression: false, autoGainControl: false },
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

      const analysis = analyzeBeatbox(audio, loadProfile())
      if (!analysis.hits.length) {
        setError('No hits detected — beatbox a bit louder and closer to the mic.')
        setPhase('idle')
        return
      }
      analysisRef.current = analysis
      const built = await buildPreview(analysis)
      const counts: Record<string, number> = {}
      for (const h of built.hits) counts[h.type] = (counts[h.type] || 0) + 1
      setResult({ bpm: built.bpm, counts, total: built.hits.length })
      setPlaying(true)
      setPhase('ready')
    } catch (e: any) {
      setError(e?.message || 'Could not analyze the recording.')
      setPhase('idle')
    }
  }

  // Build the current (un-committed) take's drums. If a session tempo is already
  // locked (a part was kept), snap this take to it so the parts line up.
  async function buildPreview(a: BeatboxResult): Promise<{ bpm: number; bars: number; hits: Hit[] }> {
    await engine.ensureStarted()
    previewIdsRef.current.forEach((id) => engine.removeTrack(id))
    previewIdsRef.current = []

    const locked = sessionBpmRef.current != null
    const bpm = locked ? (sessionBpmRef.current as number) : a.bpm
    const bars = locked ? (sessionBarsRef.current as number) : a.bars
    const hits = locked ? requantize(a.raw, bpm).hits : a.hits

    engine.setTempo(bpm)
    await engine.setKit(kitRef.current)
    const ids: string[] = []
    for (const [type, name] of DRUMS) {
      const group = hits.filter((h) => h.type === type)
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
      ids.push(id)
    }
    previewIdsRef.current = ids
    engine.setLoopBars(bars)
    await engine.play()
    return { bpm, bars, hits }
  }

  // Commit the current take as its own looping track (part).
  function keepAsTrack() {
    if (!previewIdsRef.current.length || !analysisRef.current) return
    if (sessionBpmRef.current == null) {
      sessionBpmRef.current = result?.bpm ?? analysisRef.current.bpm
      sessionBarsRef.current = analysisRef.current.bars
    }
    const types = result ? Object.keys(result.counts) : []
    const name = types.map((t) => LABELS[t] || t).join(' + ') || 'Part'
    const layer: Layer = { id: `L${Date.now().toString(36)}`, name, trackIds: previewIdsRef.current.slice(), muted: false }
    setLayers((ls) => [...ls, layer])
    previewIdsRef.current = [] // now committed — the next take won't remove it
    analysisRef.current = null
    setResult(null)
    setPhase('idle')
  }

  // Discard the current take (keeps any committed parts looping).
  function discardTake() {
    previewIdsRef.current.forEach((id) => engine.removeTrack(id))
    previewIdsRef.current = []
    analysisRef.current = null
    setResult(null)
    setError(null)
    setPhase('idle')
    if (layers.length === 0) {
      engine.stop()
      setPlaying(false)
      sessionBpmRef.current = null
      sessionBarsRef.current = null
    }
  }

  function removeLayer(id: string) {
    const layer = layers.find((l) => l.id === id)
    if (!layer) return
    layer.trackIds.forEach((tid) => engine.removeTrack(tid))
    const rest = layers.filter((l) => l.id !== id)
    setLayers(rest)
    if (rest.length === 0 && previewIdsRef.current.length === 0) {
      engine.stop()
      setPlaying(false)
      sessionBpmRef.current = null
      sessionBarsRef.current = null
    }
  }

  function toggleMute(id: string) {
    setLayers((ls) =>
      ls.map((l) => {
        if (l.id !== id) return l
        const muted = !l.muted
        l.trackIds.forEach((tid) => engine.setMute(tid, muted))
        return { ...l, muted }
      }),
    )
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

  // ½× / 2× only matters before the session tempo is locked (first part)
  async function adjustTempo(factor: number) {
    const a = analysisRef.current
    if (!a || sessionBpmRef.current != null) return
    const bpm = Math.max(50, Math.min(220, Math.round(a.bpm * factor)))
    const rq = requantize(a.raw, bpm)
    const next: BeatboxResult = { bpm, bars: rq.bars, hits: rq.hits, raw: a.raw }
    analysisRef.current = next
    const built = await buildPreview(next)
    const counts: Record<string, number> = {}
    for (const h of built.hits) counts[h.type] = (counts[h.type] || 0) + 1
    setResult({ bpm: built.bpm, counts, total: built.hits.length })
    setPlaying(true)
  }

  function changeKit(name: string) {
    setKit(name)
    kitRef.current = name
    void engine.setKit(name)
  }

  const meterScale = 1 + Math.min(0.35, level * 0.9)
  const recording = phase === 'recording'
  const analyzing = phase === 'analyzing'
  const calibrated = Object.keys(profile).length >= 2
  const hasLayers = layers.length > 0
  const locked = sessionBpmRef.current != null

  const hint = recording
    ? 'Listening… beatbox your part'
    : analyzing
      ? 'Finding the hits…'
      : result
        ? 'Nice — keep it as a track, or delete and retry.'
        : hasLayers
          ? 'Loop is playing — beatbox another part to stack it on top.'
          : 'Tap and beatbox — kick, snare, hats. Jamalam turns it into drums.'

  return (
    <div className="screen">
      <header className="top">
        <img className="logo" src="./brand/mark.png" alt="" />
        <div className="brand">
          Jamalam<span className="tag"> · beatbox → drums</span>
        </div>
      </header>

      <main className="stage">
        {hasLayers && (
          <div className="layers">
            {layers.map((l) => (
              <div key={l.id} className={`layer ${l.muted ? 'muted' : ''}`}>
                <button className="layer-name" onClick={() => toggleMute(l.id)}>
                  {l.muted ? '🔇' : '🔊'} {l.name}
                </button>
                <button className="layer-x" onClick={() => removeLayer(l.id)} aria-label="remove">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="hint">{hint}</p>

        <button
          className={`orb ${recording ? 'rec' : ''} ${analyzing ? 'busy' : ''}`}
          style={{ transform: `scale(${recording ? meterScale : 1})` }}
          onClick={recording ? stop : analyzing ? undefined : start}
          disabled={analyzing}
        >
          {recording ? '■' : analyzing ? '…' : '●'}
          <span className="orb-label">
            {recording ? fmt(elapsed) : analyzing ? 'converting' : result ? 'again' : hasLayers ? 'add part' : 'beatbox'}
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
            {!locked && (
              <div className="tempo">
                <button className="tempo-btn" onClick={() => adjustTempo(0.5)} title="Half tempo">
                  ½×
                </button>
                <span className="bpm">~{result.bpm} BPM</span>
                <button className="tempo-btn" onClick={() => adjustTempo(2)} title="Double tempo">
                  2×
                </button>
              </div>
            )}
            <div className="result-actions">
              <button className="keep" onClick={keepAsTrack}>
                ＋ Keep as track
              </button>
              <button className="play" onClick={togglePlay}>
                {playing ? '■' : '▶'}
              </button>
              <button className="delete-take" onClick={discardTake} title="Delete this take">
                🗑
              </button>
            </div>
          </div>
        )}

        {hasLayers && phase === 'idle' && (
          <button className="play wide" onClick={togglePlay}>
            {playing ? '■ Stop loop' : '▶ Play loop'}
          </button>
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
        <button className={`calib-btn ${calibrated ? 'on' : ''}`} onClick={() => setShowCalib(true)}>
          {calibrated ? '🎚 Tuned ✓' : '🎚 Calibrate'}
        </button>
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

      <Calibrate open={showCalib} initial={profile} onClose={() => setShowCalib(false)} onSaved={setProfile} />
    </div>
  )
}
