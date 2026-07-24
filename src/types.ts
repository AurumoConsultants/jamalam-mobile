export type InstrumentType =
  | 'synth'
  | 'fm'
  | 'am'
  | 'pluck'
  | 'bass'
  | 'pad'
  | 'kick'
  | 'snare'
  | 'hihat'
  | 'openhat'
  | 'clap'
  | 'tom'
  | 'rim'

export type DrumPiece = 'kick' | 'snare' | 'hihat' | 'openhat' | 'clap' | 'tom' | 'rim'

export interface Note {
  pitch: string // scientific notation, e.g. "C4"
  start: number // beats from song start
  duration: number // beats
  velocity: number // 0..1
}

export interface Track {
  id: string
  name: string
  instrument: InstrumentType
  volume: number // dB
  muted: boolean
  notes: Note[]
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// A command is a tool call the model emitted, applied to the project.
export interface Command {
  type: string
  [key: string]: any
}
