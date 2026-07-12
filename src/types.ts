export type PlayerId = string

export type StageKind = 'text' | 'drawing'

export interface GameSettings {
  promptSeconds: number
  drawingSeconds: number
}

export interface Player {
  id: PlayerId
  name: string
  joinIndex: number
  connected: boolean
  sessionId: string
}

export interface DrawPoint {
  x: number
  y: number
  pressure: number
}

export interface Stroke {
  id: string
  color: number
  size: number
  points: DrawPoint[]
}

export interface TextContent {
  kind: 'text'
  text: string
}

export interface DrawingContent {
  kind: 'drawing'
  strokes: Stroke[]
}

export type Content = TextContent | DrawingContent

export interface Candidate {
  seq: number
  sessionId: string
  content: Content
}

export interface Assignment {
  playerId: PlayerId
  bookOwnerId: PlayerId
  kind: StageKind
  draft: Candidate | null
  submission: Candidate | null
}

export interface BookEntry {
  stageIndex: number
  authorId: PlayerId
  content: Content
  source: 'submission' | 'draft' | 'fallback' | 'blank'
}

export interface Book {
  ownerId: PlayerId
  entries: BookEntry[]
}

export interface RevealState {
  bookIndex: number
  pageIndex: number
  complete: boolean
}

export interface RoundState {
  id: string
  number: number
  order: PlayerId[]
  stageIndex: number
  deadline: number
  assignments: Record<PlayerId, Assignment>
  books: Record<PlayerId, Book>
  reveal: RevealState | null
}

export type GamePhase = 'lobby' | 'stage' | 'reveal'

export interface RoomState {
  protocolVersion: 1
  roomCode: string
  creatorId: PlayerId
  adminId: PlayerId
  adminEpoch: number
  revision: number
  settings: GameSettings
  players: Record<PlayerId, Player>
  joinOrder: PlayerId[]
  phase: GamePhase
  round: RoundState | null
}

export interface PlayerSession {
  id: PlayerId
  name: string
  sessionId: string
}

export type GameIntent =
  | {
      type: 'draft'
      roundId: string
      stageIndex: number
      candidate: Candidate
    }
  | {
      type: 'submit'
      roundId: string
      stageIndex: number
      candidate: Candidate
    }
  | {type: 'settings'; settings: GameSettings}
  | {type: 'start-round'}
  | {type: 'force-advance'}
  | {type: 'reveal-page'; pageIndex: number}
  | {type: 'reveal-book'; direction: 1 | -1}
  | {type: 'reset-lobby'}

export interface IntentEnvelope {
  id: string
  senderId: PlayerId
  sessionId: string
  intent: GameIntent
}

export type WireMessage =
  | {
      type: 'join'
      player: PlayerSession
      sentAt: number
    }
  | {
      type: 'presence'
      player: PlayerSession
      sentAt: number
    }
  | {
      type: 'heartbeat'
      adminId: PlayerId
      adminEpoch: number
      revision: number
      sentAt: number
    }
  | {
      type: 'intent'
      envelope: IntentEnvelope
    }
  | {
      type: 'snapshot'
      state: RoomState
      sentAt: number
    }

export interface TransportPeer {
  id: string
  connectionState: string
}

export interface TransportSnapshot {
  kind: 'webrtc' | 'broadcast'
  selfPeerId: string
  peers: TransportPeer[]
}

export interface RoomConnection {
  status: 'connecting' | 'connected' | 'reconnecting'
  transport: TransportSnapshot
  error: string | null
}

export interface RoomSessionConfig {
  mode: 'create' | 'join'
  roomCode: string
  player: PlayerSession
  settings?: GameSettings
  transportKind?: 'webrtc' | 'broadcast'
}
