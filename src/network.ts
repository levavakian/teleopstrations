import {
  joinRoom,
  selfId,
  type JsonValue,
  type MessageAction,
  type Room,
} from '@trystero-p2p/nostr'

import type {
  TransportPeer,
  TransportSnapshot,
  WireMessage,
} from './types'

export const TURN_ISOLATION_MESSAGE =
  'No peer link could be established. This static deployment has no TURN relay, so restrictive school, office, mobile, or carrier networks may isolate this device. Try a different network.'

export function describeWebRtcJoinError(error: string): string {
  if (/turn|exchanging sdp|ice/i.test(error)) {
    return 'A direct WebRTC link failed. Updates will relay through connected players when possible; a completely isolated device needs a TURN service or a different network.'
  }
  return `A WebRTC peer link failed: ${error}`
}

const WIRE_MESSAGE_TYPES = new Set([
  'join',
  'presence',
  'heartbeat',
  'intent',
  'intent-ack',
  'snapshot',
  'sync-request',
  'sync-report',
])

export function isValidWireMessage(value: unknown): value is WireMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<WireMessage>
  if (
    typeof message.type !== 'string' ||
    !WIRE_MESSAGE_TYPES.has(message.type) ||
    typeof message.messageId !== 'string' ||
    message.messageId.length < 1 ||
    message.messageId.length > 128 ||
    !Number.isInteger(message.hopsRemaining) ||
    (message.hopsRemaining ?? -1) < 0 ||
    (message.hopsRemaining ?? 65) > 64
  ) {
    return false
  }
  try {
    if (JSON.stringify(value).length > 4_000_000) return false
  } catch {
    return false
  }
  const record = value as Record<string, unknown>
  const object = (candidate: unknown): Record<string, unknown> | null =>
    candidate && typeof candidate === 'object'
      ? (candidate as Record<string, unknown>)
      : null
  if (message.type === 'join' || message.type === 'presence') {
    const player = object(record.player)
    return Boolean(
      player &&
        typeof player.id === 'string' &&
        typeof player.name === 'string' &&
        typeof player.sessionId === 'string' &&
        typeof player.sessionStartedAt === 'number',
    )
  }
  if (message.type === 'intent') {
    const envelope = object(record.envelope)
    const intent = envelope ? object(envelope.intent) : null
    const candidate = intent ? object(intent.candidate) : null
    const content = candidate ? object(candidate.content) : null
    return Boolean(
      envelope &&
        typeof envelope.id === 'string' &&
        typeof envelope.senderId === 'string' &&
        typeof envelope.sessionId === 'string' &&
        intent &&
        typeof intent.type === 'string' &&
        (intent.type !== 'draft' && intent.type !== 'submit'
          ? true
          : candidate &&
            content &&
            typeof candidate.sessionId === 'string' &&
            typeof candidate.seq === 'number' &&
            (content.kind === 'text' || content.kind === 'drawing')),
    )
  }
  if (message.type === 'intent-ack') {
    return (
      typeof record.senderId === 'string' &&
      typeof record.sessionId === 'string' &&
      typeof record.targetPlayerId === 'string' &&
      typeof record.intentId === 'string' &&
      typeof record.accepted === 'boolean'
    )
  }
  if (message.type === 'snapshot') {
    const state = object(record.state)
    return Boolean(
      state &&
        typeof record.senderId === 'string' &&
        typeof record.sessionId === 'string' &&
        typeof state.roomCode === 'string' &&
        typeof state.creatorId === 'string' &&
        typeof state.revision === 'number' &&
        object(state.players) &&
        Array.isArray(state.joinOrder) &&
        typeof state.phase === 'string',
    )
  }
  if (message.type === 'heartbeat') {
    return (
      typeof record.creatorId === 'string' &&
      typeof record.senderId === 'string' &&
      typeof record.sessionId === 'string' &&
      object(record.cursor) !== null
    )
  }
  if (message.type === 'sync-request' || message.type === 'sync-report') {
    return (
      typeof record.roomCode === 'string' &&
      typeof record.senderId === 'string' &&
      typeof record.sessionId === 'string' &&
      (message.type === 'sync-request'
        ? record.cursor === null || object(record.cursor) !== null
        : object(record.cursor) !== null)
    )
  }
  return false
}

interface BroadcastEnvelope {
  senderPeerId: string
  targetPeerId: string | null
  message: WireMessage
}

export interface GameTransport {
  readonly kind: 'webrtc' | 'broadcast'
  readonly selfPeerId: string
  send(message: WireMessage, targetPeerId?: string): Promise<void>
  subscribe(listener: (message: WireMessage, peerId: string) => void): () => void
  subscribePeers(listener: (snapshot: TransportSnapshot) => void): () => void
  snapshot(): TransportSnapshot
  close(): Promise<void>
}

abstract class BaseTransport implements GameTransport {
  abstract readonly kind: 'webrtc' | 'broadcast'
  abstract readonly selfPeerId: string
  protected readonly messageListeners = new Set<
    (message: WireMessage, peerId: string) => void
  >()
  protected readonly peerListeners = new Set<
    (snapshot: TransportSnapshot) => void
  >()

  abstract send(message: WireMessage, targetPeerId?: string): Promise<void>
  abstract snapshot(): TransportSnapshot
  abstract close(): Promise<void>

  subscribe(
    listener: (message: WireMessage, peerId: string) => void,
  ): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  subscribePeers(listener: (snapshot: TransportSnapshot) => void): () => void {
    this.peerListeners.add(listener)
    listener(this.snapshot())
    return () => this.peerListeners.delete(listener)
  }

  protected emitMessage(message: WireMessage, peerId: string): void {
    for (const listener of this.messageListeners) listener(message, peerId)
  }

  protected emitPeers(): void {
    const snapshot = this.snapshot()
    for (const listener of this.peerListeners) listener(snapshot)
  }
}

class BroadcastTransport extends BaseTransport {
  readonly kind = 'broadcast' as const
  readonly selfPeerId = crypto.randomUUID()
  private readonly channel: BroadcastChannel
  private readonly peers = new Map<string, number>()
  private readonly cleanupTimer: number
  private closed = false

  constructor(roomCode: string) {
    super()
    this.channel = new BroadcastChannel(`teleopstrations:v2:${roomCode}`)
    this.channel.onmessage = (event: MessageEvent<BroadcastEnvelope>) => {
      const envelope = event.data
      if (
        !envelope ||
        envelope.senderPeerId === this.selfPeerId ||
        (envelope.targetPeerId &&
          envelope.targetPeerId !== this.selfPeerId)
      ) {
        return
      }
      this.peers.set(envelope.senderPeerId, Date.now())
      this.emitPeers()
      this.emitMessage(envelope.message, envelope.senderPeerId)
    }
    this.cleanupTimer = window.setInterval(() => {
      const cutoff = Date.now() - 6_000
      let changed = false
      for (const [peerId, lastSeen] of this.peers) {
        if (lastSeen < cutoff) {
          this.peers.delete(peerId)
          changed = true
        }
      }
      if (changed) this.emitPeers()
    }, 1_000)
  }

  async send(message: WireMessage, targetPeerId?: string): Promise<void> {
    this.channel.postMessage({
      senderPeerId: this.selfPeerId,
      targetPeerId: targetPeerId ?? null,
      message,
    } satisfies BroadcastEnvelope)
  }

  snapshot(): TransportSnapshot {
    return {
      kind: this.kind,
      selfPeerId: this.selfPeerId,
      peers: Array.from(this.peers.keys(), (id) => ({
        id,
        connectionState: 'connected',
      })),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    window.clearInterval(this.cleanupTimer)
    this.channel.close()
    this.messageListeners.clear()
    this.peerListeners.clear()
  }
}

class TrysteroTransport extends BaseTransport {
  readonly kind = 'webrtc' as const
  readonly selfPeerId = selfId
  private readonly room: Room
  private readonly action: MessageAction<JsonValue>
  private closed = false

  constructor(roomCode: string, onError: (message: string) => void) {
    super()
    this.room = joinRoom(
      {
        appId: 'io.github.levavakian.teleopstrations.v2',
        relayConfig: {redundancy: 5},
      },
      `game-v2:${roomCode}`,
      {
        onJoinError: ({error}) => onError(describeWebRtcJoinError(error)),
      },
    )
    this.action = this.room.makeAction<JsonValue>('game-v2')
    this.action.onMessage = (data, {peerId}) => {
      this.emitMessage(data as unknown as WireMessage, peerId)
    }
    this.room.onPeerJoin = () => {
      this.emitPeers()
    }
    this.room.onPeerLeave = () => this.emitPeers()
  }

  async send(message: WireMessage, targetPeerId?: string): Promise<void> {
    await this.action.send(message as unknown as JsonValue, {
      target: targetPeerId,
    })
  }

  snapshot(): TransportSnapshot {
    const peers = Object.entries(this.room.getPeers()).map(
      ([id, connection]): TransportPeer => ({
        id,
        connectionState: connection.connectionState,
      }),
    )
    return {kind: this.kind, selfPeerId: this.selfPeerId, peers}
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.action.onMessage = null
    this.room.onPeerJoin = null
    this.room.onPeerLeave = null
    await this.room.leave()
    this.messageListeners.clear()
    this.peerListeners.clear()
  }
}

export function createTransport(
  kind: 'webrtc' | 'broadcast',
  roomCode: string,
  onError: (message: string) => void,
): GameTransport {
  return kind === 'broadcast'
    ? new BroadcastTransport(roomCode)
    : new TrysteroTransport(roomCode, onError)
}
