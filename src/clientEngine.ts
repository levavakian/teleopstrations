import {hydrateRoomState, syncCursorForState} from './game'
import type {GameTransport} from './network'
import {
  PROTOCOL_VERSION,
  hostIncarnationOf,
  isNewerHostState,
  isValidWireMessage,
  type HostMessage,
  type WireMessage,
} from './protocol'
import type {IntentEnvelope, PlayerSession, RoomState} from './types'

export const HELLO_INTERVAL_MS = 1_000
export const FAST_HELLO_INTERVAL_MS = 300
export const PING_INTERVAL_MS = 2_000
export const REQUEST_RETRY_BASE_MS = 600
export const REQUEST_RETRY_MAX_MS = 2_000
export const HOST_OFFLINE_TIMEOUT_MS = 4_000
const MAX_PENDING_REQUESTS = 60
const MAX_CLOCK_SAMPLES = 8

interface PendingRequest {
  requestId: string
  envelope: IntentEnvelope
  attempts: number
  nextRetryAt: number
}

interface ClockSample {
  offset: number
  rtt: number
}

export interface ClientEngineOptions {
  transport: GameTransport
  roomCode: string
  player: PlayerSession
  onChange: () => void
  now?: () => number
  createId?: () => string
  random?: () => number
}

/**
 * A pure game client. Talks only to the host: sends `hello` (presence +
 * cursor + state requests), `request` (game actions, retried until acked),
 * and `ping` (clock sync). Renders exclusively host-authored state ordered by
 * `(incarnation, seq)`, so duplicated, delayed, or reordered host messages
 * can never move the client backwards.
 */
export class ClientEngine {
  state: RoomState | null = null
  hostOnline = false
  clockOffsetMs = 0
  /** Set when the host rejected a request; cleared on the next accepted state. */
  lastRejectionAt: number | null = null

  private readonly transport: GameTransport
  private readonly roomCode: string
  private readonly player: PlayerSession
  private readonly onChange: () => void
  private readonly now: () => number
  private readonly createId: () => string
  private readonly random: () => number
  private readonly unsubscribe: () => void

  private hostPeerId: string | null = null
  private lastHostSeenAt = 0
  private adopted: {incarnation: number; seq: number} | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly clockSamples: ClockSample[] = []
  private hasPongSample = false
  private readonly pingSentAt = new Map<string, number>()
  private lastHelloAt = 0
  private lastPingAt = 0
  private needState = true
  private stopped = false

  constructor(options: ClientEngineOptions) {
    this.transport = options.transport
    this.roomCode = options.roomCode
    this.player = options.player
    this.onChange = options.onChange
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.random = options.random ?? Math.random
    this.unsubscribe = this.transport.subscribe((message, peerId) => {
      this.handleMessage(message, peerId)
    })
    this.sendHello(this.now())
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.unsubscribe()
  }

  get pendingRequestCount(): number {
    return this.pending.size
  }

  /** Queues an intent for the host, retrying until acknowledged. */
  request(envelope: IntentEnvelope): void {
    if (this.stopped) return
    const nowMs = this.now()

    // Newer drafts/submissions for the same stage supersede queued ones.
    if (
      envelope.intent.type === 'draft' ||
      envelope.intent.type === 'submit'
    ) {
      for (const [id, queued] of this.pending) {
        const intent = queued.envelope.intent
        if (
          intent.type === envelope.intent.type &&
          (intent.type === 'draft' || intent.type === 'submit') &&
          intent.roundId === envelope.intent.roundId &&
          intent.stageIndex === envelope.intent.stageIndex
        ) {
          this.pending.delete(id)
        }
      }
    }
    while (this.pending.size >= MAX_PENDING_REQUESTS) {
      const draft = Array.from(this.pending).find(
        ([, queued]) => queued.envelope.intent.type === 'draft',
      )
      const oldest = draft ?? this.pending.entries().next().value
      if (!oldest) break
      this.pending.delete(oldest[0])
    }

    const requestId = envelope.id
    this.pending.set(requestId, {
      requestId,
      envelope,
      attempts: 1,
      nextRetryAt: nowMs + REQUEST_RETRY_BASE_MS,
    })
    this.send({
      v: PROTOCOL_VERSION,
      roomCode: this.roomCode,
      kind: 'request',
      requestId,
      envelope,
    })
  }

  /** Drives hellos, pings, retries, and host liveness. Call every ~100-250 ms. */
  pump(nowMs: number = this.now()): void {
    if (this.stopped) return

    const helloInterval = this.needState
      ? FAST_HELLO_INTERVAL_MS
      : HELLO_INTERVAL_MS
    if (nowMs - this.lastHelloAt >= helloInterval) {
      this.sendHello(nowMs)
    }

    if (nowMs - this.lastPingAt >= PING_INTERVAL_MS) {
      this.lastPingAt = nowMs
      const pingId = this.createId()
      this.pingSentAt.set(pingId, nowMs)
      if (this.pingSentAt.size > 16) {
        const oldest = this.pingSentAt.keys().next().value
        if (oldest) this.pingSentAt.delete(oldest)
      }
      this.send({
        v: PROTOCOL_VERSION,
        roomCode: this.roomCode,
        kind: 'ping',
        pingId,
        clientTime: nowMs,
      })
    }

    for (const queued of this.pending.values()) {
      if (queued.nextRetryAt > nowMs) continue
      queued.attempts += 1
      queued.nextRetryAt =
        nowMs +
        Math.min(
          REQUEST_RETRY_MAX_MS,
          REQUEST_RETRY_BASE_MS * 2 ** Math.min(queued.attempts - 1, 3),
        ) +
        Math.floor(this.random() * 200)
      this.send({
        v: PROTOCOL_VERSION,
        roomCode: this.roomCode,
        kind: 'request',
        requestId: queued.requestId,
        envelope: queued.envelope,
      })
    }

    const online =
      this.lastHostSeenAt > 0 &&
      nowMs - this.lastHostSeenAt < HOST_OFFLINE_TIMEOUT_MS
    if (online !== this.hostOnline) {
      this.hostOnline = online
      if (!online) this.hostPeerId = null
      this.onChange()
    }
  }

  private sendHello(nowMs: number): void {
    this.lastHelloAt = nowMs
    this.send({
      v: PROTOCOL_VERSION,
      roomCode: this.roomCode,
      kind: 'hello',
      player: this.player,
      cursor: this.state ? syncCursorForState(this.state) : null,
      wantState: this.needState,
    })
  }

  private handleMessage(message: unknown, peerId: string): void {
    if (this.stopped) return
    if (!isValidWireMessage(message, this.roomCode)) return
    const hostMessage = message as HostMessage
    const nowMs = this.now()

    switch (hostMessage.kind) {
      case 'state': {
        const incoming = hydrateRoomState(hostMessage.state)
        if (
          incoming.roomCode !== this.roomCode ||
          hostIncarnationOf(incoming) !== hostMessage.incarnation ||
          incoming.revision !== hostMessage.seq
        ) {
          return
        }
        this.markHostSeen(peerId, nowMs)
        const stamp = {
          incarnation: hostMessage.incarnation,
          seq: hostMessage.seq,
        }
        if (!isNewerHostState(this.adopted, stamp)) return
        this.adopted = stamp
        this.state = incoming
        this.needState = false
        this.lastRejectionAt = null
        this.addFallbackClockSample(hostMessage.serverTime - nowMs)
        this.onChange()
        return
      }
      case 'tick': {
        this.markHostSeen(peerId, nowMs)
        if (
          isNewerHostState(this.adopted, {
            incarnation: hostMessage.incarnation,
            seq: hostMessage.seq,
          })
        ) {
          if (!this.needState) {
            this.needState = true
            this.sendHello(nowMs)
          }
        }
        this.addFallbackClockSample(hostMessage.serverTime - nowMs)
        this.onChange()
        return
      }
      case 'ack': {
        if (
          hostMessage.playerId !== this.player.id ||
          hostMessage.sessionId !== this.player.sessionId
        ) {
          return
        }
        this.markHostSeen(peerId, nowMs)
        const queued = this.pending.get(hostMessage.requestId)
        if (!queued) return
        this.pending.delete(hostMessage.requestId)
        if (!hostMessage.accepted) {
          this.lastRejectionAt = nowMs
          this.needState = true
          this.sendHello(nowMs)
        }
        this.onChange()
        return
      }
      case 'pong': {
        this.markHostSeen(peerId, nowMs)
        const sentAt = this.pingSentAt.get(hostMessage.pingId)
        if (sentAt === undefined) return
        this.pingSentAt.delete(hostMessage.pingId)
        const rtt = Math.max(0, nowMs - sentAt)
        this.addPongClockSample(
          hostMessage.serverTime + rtt / 2 - nowMs,
          rtt,
        )
        return
      }
      default:
        return
    }
  }

  private markHostSeen(peerId: string, nowMs: number): void {
    this.hostPeerId = peerId
    this.lastHostSeenAt = nowMs
    if (!this.hostOnline) {
      this.hostOnline = true
      this.onChange()
    }
  }

  /**
   * Clock samples are weighted by round-trip time: the lowest-RTT sample in
   * the window wins, so asymmetric one-way delays cannot skew the countdown.
   */
  private addPongClockSample(offset: number, rtt: number): void {
    this.hasPongSample = true
    this.clockSamples.push({offset, rtt})
    if (this.clockSamples.length > MAX_CLOCK_SAMPLES) {
      this.clockSamples.shift()
    }
    const best = this.clockSamples.reduce((left, right) =>
      right.rtt < left.rtt ? right : left,
    )
    this.clockOffsetMs = best.offset
  }

  /**
   * One-way samples from ticks/states have unknown delay, so they only seed
   * the offset until the first round-trip measurement exists.
   */
  private addFallbackClockSample(offset: number): void {
    if (this.hasPongSample) return
    this.clockOffsetMs = offset
  }

  private send(message: WireMessage): void {
    void this.transport
      .send(message, this.hostPeerId ?? undefined)
      .catch(() => {
        // Transport failures surface through host liveness, not here.
      })
  }
}
