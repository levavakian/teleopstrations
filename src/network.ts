import {
  getRelaySockets,
  joinRoom,
  selfId,
  type JsonValue,
  type MessageAction,
  type Room,
  type TurnServerConfig,
} from '@trystero-p2p/nostr'

import {loadTurnServers} from './storage'
import type {WireMessage} from './protocol'
import type {TransportPeer, TransportSnapshot} from './types'

/** Discovery works but nobody answered: the room is probably not live. */
export const ROOM_SILENT_MESSAGE =
  'No one was found in this room yet. The host may be offline or the room code mistyped — if the host closed their tab, they can rejoin with the same name and room code to bring the room back. If the game was just updated, every player should reload the page so everyone runs the same version.'

/** The signaling relays themselves are unreachable from this network. */
export const SIGNALING_BLOCKED_MESSAGE =
  'The peer discovery relays could not be reached, so this network may block them. Try a different network or connection.'

export function describeWebRtcJoinError(error: string): string {
  if (/turn|exchanging sdp|ice/i.test(error)) {
    return 'Another player was found, but a connection could not form between your devices — even through the built-in TURN relay. That usually means the relay’s shared monthly quota is exhausted or this network blocks relay traffic entirely. You can add your own TURN credentials under “Connection help” on the home screen, then share a fresh invite link — the link carries the relay settings to everyone who opens it.'
  }
  return `A WebRTC peer link failed: ${error}`
}

/**
 * Extra STUN servers appended to Trystero's defaults (Google on 19302,
 * Cloudflare on 3478). Chosen for provider and port diversity — a network
 * that filters one provider or port often passes another — and each extra
 * reflexive candidate is one more chance for hole punching to land.
 * Verified reachable via scripts/probe-turn.mjs-style ICE gathering.
 */
const EXTRA_STUN_SERVERS: TurnServerConfig[] = [
  {urls: 'stun:global.stun.twilio.com:3478'},
  {urls: 'stun:stun.relay.metered.ca:80'},
  {urls: 'stun:stun.nextcloud.com:443'},
]

/**
 * Built-in TURN relay so games connect deterministically instead of
 * depending on NAT hole-punching luck. These are static credentials for a
 * Metered free-tier account (20 GB/month, shared by everyone playing from
 * this deployment; drawings and JSON are tiny). They are public by nature —
 * this is a static site in a public repo — so if the quota is ever burned
 * by freeloaders, rotate them in the Metered dashboard and update this
 * list. If the relay is unreachable or exhausted, connections degrade to
 * direct hole punching plus any player-configured TURN servers.
 * The port-80/443 and TCP/TLS variants matter: they slip through networks
 * that block UDP or unusual ports.
 */
const DEFAULT_TURN_SERVERS: TurnServerConfig[] = [
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: '6174fd59e7cabfa51a3707e5',
    credential: '45OgEggvC+MGaHW8',
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: '6174fd59e7cabfa51a3707e5',
    credential: '45OgEggvC+MGaHW8',
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: '6174fd59e7cabfa51a3707e5',
    credential: '45OgEggvC+MGaHW8',
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: '6174fd59e7cabfa51a3707e5',
    credential: '45OgEggvC+MGaHW8',
  },
]

/**
 * The full ICE server list for joining a room: diverse STUN, the built-in
 * TURN relay, then any player-configured TURN servers (manual or adopted
 * from an invite link), deduplicated. ICE simply races every server, so
 * extras can only add paths, never remove them.
 */
export function turnConfigForJoin(): TurnServerConfig[] {
  const merged: TurnServerConfig[] = []
  const seen = new Set<string>()
  for (const server of [
    ...EXTRA_STUN_SERVERS,
    ...DEFAULT_TURN_SERVERS,
    ...(loadTurnServers() ?? []),
  ]) {
    const key = JSON.stringify(server)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(server)
  }
  return merged
}

/**
 * True when a peer's RTCPeerConnection state says the link is beyond quick
 * repair. 'disconnected' can technically self-heal, but combined with host
 * silence it reliably means the path died (for example after a WiFi change).
 */
export function isDeadPeerLink(connectionState: string): boolean {
  return (
    connectionState === 'failed' ||
    connectionState === 'disconnected' ||
    connectionState === 'closed'
  )
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
  /** Whether the peer-discovery layer itself is reachable right now. */
  signalingConnected(): boolean
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
  abstract signalingConnected(): boolean
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
    this.channel = new BroadcastChannel(`teleopstrations:v3:${roomCode}`)
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

  signalingConnected(): boolean {
    return true
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

  constructor(
    roomCode: string,
    onError: (message: string) => void,
    relayOnly: boolean,
  ) {
    super()
    this.room = joinRoom(
      {
        appId: 'io.github.levavakian.teleopstrations.v3',
        // Trystero's default relay pool contains some dead entries; a wider
        // deterministic selection keeps several healthy relays in common
        // across all players even when a few are unreachable.
        relayConfig: {redundancy: 10},
        // Trystero appends this to its default STUN list.
        turnConfig: turnConfigForJoin(),
        // Relay-only mode excludes direct candidates entirely: used when a
        // device opted in ("always use the relay") or after a live link
        // died mid-session, where deterministic beats fast.
        ...(relayOnly
          ? {rtcConfig: {iceTransportPolicy: 'relay' as RTCIceTransportPolicy}}
          : {}),
      },
      `game-v3:${roomCode}`,
      {
        onJoinError: ({error}) => onError(describeWebRtcJoinError(error)),
      },
    )
    this.action = this.room.makeAction<JsonValue>('game-v3')
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

  signalingConnected(): boolean {
    try {
      const sockets = getRelaySockets() as Record<string, WebSocket>
      return Object.values(sockets).some(
        (socket) => socket?.readyState === WebSocket.OPEN,
      )
    } catch {
      return false
    }
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

export type {TurnServerConfig}

export function createTransport(
  kind: 'webrtc' | 'broadcast',
  roomCode: string,
  onError: (message: string) => void,
  options: {relayOnly?: boolean} = {},
): GameTransport {
  return kind === 'broadcast'
    ? new BroadcastTransport(roomCode)
    : new TrysteroTransport(roomCode, onError, options.relayOnly ?? false)
}

/**
 * Replaces a transport during a hard reconnect. The old transport must be
 * fully closed *before* the new one is created: Trystero caches the live
 * room per room ID, so joining again too early would adopt the old room and
 * the pending leave would then destroy it out from under the replacement.
 */
export async function replaceTransport(
  stale: GameTransport,
  create: () => GameTransport,
): Promise<GameTransport> {
  try {
    await stale.close()
  } catch {
    // A rejected leave means the old room was never torn down. Joining
    // again then reuses the still-live cached room and simply rewires the
    // message handlers onto it, which is safe.
  }
  return create()
}
