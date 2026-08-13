import type {
  GamePhase,
  IntentEnvelope,
  PlayerSession,
  RoomState,
  SyncCursor,
} from './types'

export const PROTOCOL_VERSION = 3

/**
 * Star-topology wire protocol. Exactly one host (the room creator) acts as
 * the server; every other client talks only to the host. There is no message
 * relaying, no gossip, and no host election.
 *
 * Client -> host: `hello`, `request`, `ping`.
 * Host -> client: `state`, `ack`, `tick`, `pong`.
 *
 * The host incarnation is the creator's `sessionStartedAt`, which increases
 * strictly on every host resume, so `(incarnation, seq)` totally orders all
 * host output across restarts.
 */

interface BaseMessage {
  v: typeof PROTOCOL_VERSION
  roomCode: string
}

export interface HelloMessage extends BaseMessage {
  kind: 'hello'
  player: PlayerSession
  /** Client's current position, or null before any state was received. */
  cursor: SyncCursor | null
  /** Ask the host for a full state message even if the cursor looks current. */
  wantState: boolean
}

export interface RequestMessage extends BaseMessage {
  kind: 'request'
  requestId: string
  envelope: IntentEnvelope
}

export interface PingMessage extends BaseMessage {
  kind: 'ping'
  pingId: string
  clientTime: number
}

export interface StateMessage extends BaseMessage {
  kind: 'state'
  incarnation: number
  seq: number
  serverTime: number
  state: RoomState
}

export interface AckMessage extends BaseMessage {
  kind: 'ack'
  requestId: string
  playerId: string
  sessionId: string
  accepted: boolean
  seq: number
  serverTime: number
}

export interface TickMessage extends BaseMessage {
  kind: 'tick'
  incarnation: number
  hostSessionId: string
  seq: number
  serverTime: number
  phase: GamePhase
  deadline: number | null
}

export interface PongMessage extends BaseMessage {
  kind: 'pong'
  pingId: string
  clientTime: number
  serverTime: number
}

export type ClientMessage = HelloMessage | RequestMessage | PingMessage
export type HostMessage = StateMessage | AckMessage | TickMessage | PongMessage
export type WireMessage = ClientMessage | HostMessage

const CLIENT_KINDS = new Set(['hello', 'request', 'ping'])
const HOST_KINDS = new Set(['state', 'ack', 'tick', 'pong'])

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isValidPlayerShape(value: unknown): boolean {
  if (!isObject(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    typeof value.name === 'string' &&
    value.name.length <= 64 &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length <= 128 &&
    Number.isFinite(value.sessionStartedAt)
  )
}

function isValidEnvelopeShape(value: unknown): boolean {
  if (!isObject(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.senderId === 'string' &&
    typeof value.sessionId === 'string' &&
    isObject(value.intent) &&
    typeof (value.intent as Record<string, unknown>).type === 'string'
  )
}

function isValidStateShape(value: unknown): boolean {
  if (!isObject(value)) return false
  return (
    typeof value.roomCode === 'string' &&
    typeof value.creatorId === 'string' &&
    typeof value.revision === 'number' &&
    typeof value.phase === 'string' &&
    isObject(value.players) &&
    Array.isArray(value.joinOrder)
  )
}

export function isValidWireMessage(
  value: unknown,
  roomCode: string,
): value is WireMessage {
  if (!isObject(value)) return false
  if (value.v !== PROTOCOL_VERSION || value.roomCode !== roomCode) return false
  const kind = value.kind
  if (typeof kind !== 'string') return false
  if (!CLIENT_KINDS.has(kind) && !HOST_KINDS.has(kind)) return false

  switch (kind) {
    case 'hello':
      return (
        isValidPlayerShape(value.player) &&
        typeof value.wantState === 'boolean' &&
        (value.cursor === null || isObject(value.cursor))
      )
    case 'request':
      return (
        typeof value.requestId === 'string' &&
        value.requestId.length <= 128 &&
        isValidEnvelopeShape(value.envelope)
      )
    case 'ping':
      return (
        typeof value.pingId === 'string' && Number.isFinite(value.clientTime)
      )
    case 'state':
      return (
        Number.isFinite(value.incarnation) &&
        Number.isFinite(value.seq) &&
        Number.isFinite(value.serverTime) &&
        isValidStateShape(value.state)
      )
    case 'ack':
      return (
        typeof value.requestId === 'string' &&
        typeof value.playerId === 'string' &&
        typeof value.sessionId === 'string' &&
        typeof value.accepted === 'boolean' &&
        Number.isFinite(value.seq)
      )
    case 'tick':
      return (
        Number.isFinite(value.incarnation) &&
        typeof value.hostSessionId === 'string' &&
        Number.isFinite(value.seq) &&
        Number.isFinite(value.serverTime) &&
        typeof value.phase === 'string' &&
        (value.deadline === null || Number.isFinite(value.deadline))
      )
    case 'pong':
      return (
        typeof value.pingId === 'string' &&
        Number.isFinite(value.clientTime) &&
        Number.isFinite(value.serverTime)
      )
    default:
      return false
  }
}

export function isClientMessage(message: WireMessage): message is ClientMessage {
  return CLIENT_KINDS.has(message.kind)
}

export function isHostMessage(message: WireMessage): message is HostMessage {
  return HOST_KINDS.has(message.kind)
}

/** Incarnation of the host that produced a state: strictly grows on resume. */
export function hostIncarnationOf(state: RoomState): number {
  return state.players[state.creatorId]?.sessionStartedAt ?? 0
}

export function hostSessionIdOf(state: RoomState): string {
  return state.players[state.creatorId]?.sessionId ?? ''
}

/**
 * Total order over host output: newer incarnation always wins; within one
 * incarnation the sequence number wins. Used by clients to ignore stale or
 * duplicated host messages regardless of arrival order.
 */
export function isNewerHostState(
  local: {incarnation: number; seq: number} | null,
  incoming: {incarnation: number; seq: number},
): boolean {
  if (!local) return true
  if (incoming.incarnation !== local.incarnation) {
    return incoming.incarnation > local.incarnation
  }
  return incoming.seq > local.seq
}
