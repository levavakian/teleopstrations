import type {
  GameIntent,
  GameSettings,
  PeerSyncReport,
  PlayerId,
  PlayerSession,
  RoomState,
  SyncCursor,
} from './types'

/**
 * The WebSocket wire protocol between the game server and browser clients.
 * The transport is reliable and ordered, so there are no acks, retries, or
 * sequence numbers: the server owns the canonical state and pushes it on
 * every visible change.
 */

export interface JoinMessage {
  type: 'join'
  roomCode: string
  player: PlayerSession
  /** Create the room if it does not exist (the creator becomes admin). */
  create: boolean
  settings?: GameSettings
}

export interface IntentMessage {
  type: 'intent'
  intent: GameIntent
}

export interface CursorMessage {
  type: 'cursor'
  cursor: SyncCursor
}

export interface PingMessage {
  type: 'ping'
  id: string
  clientTime: number
}

export type ClientMessage =
  | JoinMessage
  | IntentMessage
  | CursorMessage
  | PingMessage

export type JoinErrorCode = 'not-found' | 'blocked' | 'invalid'

export interface JoinedMessage {
  type: 'joined'
  state: RoomState
  serverTime: number
}

export interface StateMessage {
  type: 'state'
  state: RoomState
  serverTime: number
}

export interface TickMessage {
  type: 'tick'
  serverTime: number
  reports: Record<PlayerId, PeerSyncReport>
}

export interface PongMessage {
  type: 'pong'
  id: string
  clientTime: number
  serverTime: number
}

export interface JoinErrorMessage {
  type: 'join-error'
  code: JoinErrorCode
  message: string
}

/** Another connection took over this player's seat. */
export interface SupersededMessage {
  type: 'superseded'
}

export type ServerMessage =
  | JoinedMessage
  | StateMessage
  | TickMessage
  | PongMessage
  | JoinErrorMessage
  | SupersededMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isSessionShape(value: unknown): value is PlayerSession {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    value.name.length <= 64 &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 128 &&
    typeof value.sessionStartedAt === 'number' &&
    Number.isFinite(value.sessionStartedAt)
  )
}

/**
 * Shape-level validation for inbound client messages. Deep validation of
 * intent payloads (content sizes, ranges) happens in the game reducer.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'join':
      return typeof value.roomCode === 'string' &&
        value.roomCode.length <= 16 &&
        typeof value.create === 'boolean' &&
        isSessionShape(value.player) &&
        (value.settings === undefined || isRecord(value.settings))
        ? (value as unknown as JoinMessage)
        : null
    case 'intent':
      return isRecord(value.intent) &&
        typeof value.intent.type === 'string'
        ? (value as unknown as IntentMessage)
        : null
    case 'cursor':
      return isRecord(value.cursor) ? (value as unknown as CursorMessage) : null
    case 'ping':
      return typeof value.id === 'string' &&
        value.id.length <= 64 &&
        typeof value.clientTime === 'number'
        ? (value as unknown as PingMessage)
        : null
    default:
      return null
  }
}
