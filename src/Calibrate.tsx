import { useEffect, useRef, useState } from 'react'
import { profileFromBuffer, type DrumProfile, type DrumType } from './audio/beatbox'
import { saveProfile, clearProfile } from './audio/profile'

const STEPS: { type: DrumType; title: string; cue: string; say: string }[] = [
  { type: 'kick', title: 'Kick / Bass drum', cue: 'Deep chest "b" — like "boom"', say: 'b · b · b · b' },
  { type: 'snare', title: 'Snare', cue: 'Sharp "k", "psh" or "ka"', say: 'k · psh · k · psh' },
  { type: 'hihat', title: 'Closed hi-hat', cue: 'Short crisp "ts" — cut it off', say: 'ts · ts · ts · ts' },
  { type: 'openhat', title: 'Open hi-hat', cue: 'Long airy "tsss" — let it ring', say: 'tsss — tsss' },
]
const REC_MS = 2600

export default function Calibrate({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean
  initial: DrumProfile
  onClose: () => void
  onSaved: (p: DrumProfile) => void
}) {
  const [step, setStep] = useState(0)
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [captured, setCaptured] = useState<Record<string, boolean>>(() => {
    const c: Record<string, boolean> = {}
    for (const k of Object.keys(initial)) c[k] = true
    return c
  })
  const profileRef = useRef<DrumProfile>({ ...initial })

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const rafRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) cleanup()
    return () => cleanup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function cleanup() {
    if (timerRef.current) clearTimeout(timerRef.current)
    cancelAnimationFrame(rafRef.current)
    try {
      if (recRef.current && recRef.current.state === 'recording') recRef.current.stop()
    } catch {
      // ignore
    }
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    } catch {
      // ignore
    }
    try {
      ctxRef.current?.close()
    } catch {
      // ignore
    }
    streamRef.current = null
    ctxRef.current = null
    setRecording(false)
    setLevel(0)
  }

  async function record() {
    setError(null)
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
      src.connect(an)
      const buf = new Float32Array(2048)
      const rec = new MediaRecorder(stream)
      recRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.onstop = onStopped
      rec.start()
      setRecording(true)
      const tick = () => {
        an.getFloatTimeDomainData(buf as any)
        let p = 0
        for (const v of buf) {
          const a = v < 0 ? -v : v
          if (a > p) p = a
        }
        setLevel(p)
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
      timerRef.current = setTimeout(() => {
        try {
          rec.stop()
        } catch {
          // ignore
        }
      }, REC_MS)
    } catch (e: any) {
      setError(
        e?.name === 'NotAllowedError'
          ? 'Mic blocked — allow microphone access for Jamalam and try again.'
          : e?.message || 'Could not open the microphone.',
      )
      setRecording(false)
    }
  }

  async function onStopped() {
    cancelAnimationFrame(rafRef.current)
    setRecording(false)
    setLevel(0)
    try {
      const blob = new Blob(chunksRef.current)
      const ctx = ctxRef.current ?? new AudioContext()
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer())
      streamRef.current?.getTracks().forEach((t) => t.stop())
      const fp = profileFromBuffer(audio)
      if (!fp) {
        setError('Didn’t catch a clear sound — try again, louder and closer to the mic.')
        return
      }
      const t = STEPS[step].type
      profileRef.current = { ...profileRef.current, [t]: fp }
      setCaptured((c) => ({ ...c, [t]: true }))
    } catch (e: any) {
      setError(e?.message || 'Could not analyze that sound.')
    }
  }

  function finish() {
    saveProfile(profileRef.current)
    onSaved(profileRef.current)
    onClose()
  }

  // wipe the whole profile and start from scratch (back to generic detection)
  function reset() {
    clearProfile()
    profileRef.current = {}
    setCaptured({})
    setStep(0)
    setError(null)
    onSaved({})
  }

  if (!open) return null
  const s = STEPS[step]
  const done = !!captured[s.type]
  const capturedCount = STEPS.filter((x) => captured[x.type]).length
  const scale = 1 + Math.min(0.4, level * 1.1)
  const last = step === STEPS.length - 1

  return (
    <div className="calib-screen">
      <div className="calib-top">
        <button className="calib-x" onClick={onClose} disabled={recording}>
          ✕
        </button>
        <div className="calib-progress">
          {STEPS.map((x, i) => (
            <button
              key={x.type}
              className={`cdot ${i === step ? 'cur' : ''} ${captured[x.type] ? 'ok' : ''}`}
              onClick={() => !recording && setStep(i)}
            >
              {captured[x.type] ? '✓' : i + 1}
            </button>
          ))}
        </div>
      </div>

      <div className="calib-body">
        <div className="calib-title">{s.title}</div>
        <div className="calib-cue">{s.cue}</div>
        <div className="calib-say">{s.say}</div>

        <button
          className={`orb calib ${recording ? 'rec' : ''}`}
          style={{ transform: `scale(${recording ? scale : 1})` }}
          onClick={recording ? undefined : record}
          disabled={recording}
        >
          {recording ? '●' : done ? '↺' : '●'}
          <span className="orb-label">{recording ? 'make it 4×' : done ? 'redo' : 'record'}</span>
        </button>

        {error && <div className="error">{error}</div>}
      </div>

      <div className="calib-actions">
        {!last ? (
          <button className="play" onClick={() => setStep(step + 1)} disabled={recording}>
            Next ›
          </button>
        ) : (
          <button className="play" onClick={finish} disabled={capturedCount < 2 || recording}>
            Save &amp; use
          </button>
        )}
      </div>
      <div className="calib-count">
        {capturedCount}/{STEPS.length} sounds captured
        {capturedCount > 0 && (
          <button className="calib-reset" onClick={reset} disabled={recording}>
            ↺ Start over
          </button>
        )}
      </div>
    </div>
  )
}
