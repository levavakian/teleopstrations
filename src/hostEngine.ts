import {
  advanceStage,
  applyIntent,
  getSubmissionCount,
  joinPlayer,
  normalizeName,
  playerIdForName,
  reclaimPlayerSession,
  redactStateForWire,
  setPlayerConnected,
  syncCursorForState,
} from './game'
import type {GameTransport} from './network'
import {
  PROTOCOL_VERSION,
  hostIncarnationOf,
  hostSessionIdOf,
  isValidWireMessage,
  type AckMessage,
  type ClientMessage,
  type StateMessage,
  type TickMessage,
  type WireMessage,
} from './protocol'
import type {
  IntentEnvelope,
  PeerSyncReport,
  PlayerSession,
  RoomState,
} from './types'

export const HOST_TICK_INTERVAL_MS = 1_000
export const PLAYER_PRESENCE_TIMEOUT_MS = 5_000
export const DEFERRED_BROADCAST_INTERVAL_MS = 400
const MAX_REQUEST_RESULTS = 2_000

interface RequestResult {
  accepted: boolean
  seq: number
  kind: string
}

export interface HostEngineOptions {
  transport: GameTransport
  roomCode: string
  player: PlayerSession
  initialState: RoomState
  onChange: () => void
  persist?: (state: RoomState) => void
  now?: () => number
}

function isValidJoiningPlayer(player: PlayerSession): boolean {
  const name = normalizeName(player.name)
  return (
    name.length > 0 &&
    name.length <= 36 &&
    player.id === playerIdForName(name) &&
    typeof player.sessionId === 'string' &&
    player.sessionId.length > 0 &&
    player.sessionId.length <= 128 &&
    Number.isFinite(player.sessionStartedAt)
  )
}

/**
 * The per-room server. Runs only in the room creator's tab. Owns the
 * canonical `RoomState`, applies every intent serially, and broadcasts
 * ordered state messages plus a 1 Hz timing tick. Never transfers authority;
 * if a resumed host with a newer incarnation appears, this engine fences
 * itself permanently.
 */
export class HostEngine {
  state: RoomState
  fenced = false
  syncReports: Record<string, PeerSyncReport> = {}

  private transport: GameTransport
  private readonly roomCode: string
  private readonly player: PlayerSession
  private readonly onChange: () => void
  private readonly persistState?: (state: RoomState) => void
  private readonly now: () => number
  private unsubscribe: () => void

  private readonly lastSeenByPlayer = new Map<string, number>()
  private readonly peerByPlayer = new Map<string, string>()
  private readonly requestResults = new Map<string, RequestResult>()
  private broadcastDirty = false
  private lastBroadcastAt = 0
  private lastTickAt = 0
  private stopped = false

  constructor(options: HostEngineOptions) {
    this.transport = options.transport
    this.roomCode = options.roomCode
    this.player = options.player
    this.state = options.initialState
    this.onChange = options.onChange
    this.persistState = options.persist
    this.now = options.now ?? Date.now
    this.unsubscribe = this.transport.subscribe((message, peerId) => {
      this.handleMessage(message, peerId)
    })
    this.persistState?.(this.state)
    this.broadcastState()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.unsubscribe()
  }

  /**
   * Swaps in a fresh transport after a hard reconnect (for example, the
   * host's device changed networks). Canonical state is untouched; clients
   * relearn the host's peer link from the immediate state broadcast.
   */
  attachTransport(transport: GameTransport): void {
    if (this.stopped) return
    this.unsubscribe()
    this.transport = transport
    this.unsubscribe = transport.subscribe((message, peerId) => {
      this.handleMessage(message, peerId)
    })
    this.peerByPlayer.clear()
    if (!this.fenced) this.broadcastState()
  }

  get incarnation(): number {
    return hostIncarnationOf(this.state)
  }

  /** Applies an intent from the host's own UI. */
  submitLocal(envelope: IntentEnvelope): void {
    if (this.fenced || this.stopped) return
    const applied = this.applyEnvelope(envelope)
    if (applied.changed) {
      this.publish(
        applied.next,
        envelope.intent.type === 'draft' && !applied.stageTransitioned
          ? 'silent'
          : 'now',
      )
    }
  }

  /** Advances timers and periodic broadcasts. Call every ~100-250 ms. */
  pump(nowMs: number = this.now()): void {
    if (this.fenced || this.stopped) return

    let next = this.state
    for (const playerId of next.joinOrder) {
      if (playerId === this.player.id) continue
      const connected =
        nowMs - (this.lastSeenByPlayer.get(playerId) ?? 0) <
        PLAYER_PRESENCE_TIMEOUT_MS
      next = setPlayerConnected(next, playerId, connected)
    }
    if (next !== this.state) this.publish(next, 'defer')

    if (
      this.state.phase === 'stage' &&
      this.state.round &&
      nowMs >= this.state.round.deadline
    ) {
      this.publish(advanceStage(this.state, nowMs), 'now')
    }

    if (
      this.broadcastDirty &&
      nowMs - this.lastBroadcastAt >= DEFERRED_BROADCAST_INTERVAL_MS
    ) {
      this.broadcastState()
    }

    if (nowMs - this.lastTickAt >= HOST_TICK_INTERVAL_MS) {
      this.lastTickAt = nowMs
      this.send(this.buildTick(nowMs))
    }
  }

  private handleMessage(message: unknown, peerId: string): void {
    if (this.stopped) return
    if (!isValidWireMessage(message, this.roomCode)) return

    if (message.kind === 'state' || message.kind === 'tick') {
      const incoming =
        message.kind === 'state'
          ? {
              incarnation: message.incarnation,
              sessionId: hostSessionIdOf(message.state),
            }
          : {incarnation: message.incarnation, sessionId: message.hostSessionId}
      const mine = {
        incarnation: this.incarnation,
        sessionId: this.player.sessionId,
      }
      if (
        !this.fenced &&
        (incoming.incarnation > mine.incarnation ||
          (incoming.incarnation === mine.incarnation &&
            incoming.sessionId > mine.sessionId))
      ) {
        this.fenced = true
        this.onChange()
      }
      return
    }

    if (this.fenced) return
    switch (message.kind) {
      case 'hello':
        this.handleHello(message, peerId)
        return
      case 'request':
        this.handleRequest(message, peerId)
        return
      case 'ping':
        this.send(
          {
            v: PROTOCOL_VERSION,
            roomCode: this.roomCode,
            kind: 'pong',
            pingId: message.pingId,
            clientTime: message.clientTime,
            serverTime: this.now(),
          },
          peerId,
        )
        return
      default:
        return
    }
  }

  private handleHello(
    message: Extract<ClientMessage, {kind: 'hello'}>,
    peerId: string,
  ): void {
    const {player, cursor, wantState} = message
    if (!isValidJoiningPlayer(player)) return
    const nowMs = this.now()
    this.peerByPlayer.set(player.id, peerId)

    const known = this.state.players[player.id]
    const isForeignCreatorSession =
      player.id === this.state.creatorId &&
      player.sessionId !== this.player.sessionId

    if (!isForeignCreatorSession) {
      if (known?.sessionId === player.sessionId) {
        this.lastSeenByPlayer.set(player.id, nowMs)
        const next = setPlayerConnected(this.state, player.id, true)
        if (next !== this.state) this.publish(next, 'now')
      } else if (known) {
        // Only a strictly newer session may take over a seat, so a stale
        // tab's hellos can never steal the seat back from a reclaimed one.
        const incomingIsNewer =
          player.sessionStartedAt > known.sessionStartedAt ||
          (player.sessionStartedAt === known.sessionStartedAt &&
            player.sessionId > known.sessionId)
        if (incomingIsNewer) {
          const next = reclaimPlayerSession(this.state, player)
          if (next !== this.state) {
            this.lastSeenByPlayer.set(player.id, nowMs)
            this.publish(next, 'now')
          }
        }
      } else {
        const next = joinPlayer(this.state, player)
        if (next !== this.state) {
          this.lastSeenByPlayer.set(player.id, nowMs)
          this.publish(next, 'now')
        }
      }
    }

    if (cursor && this.state.players[player.id]?.sessionId === player.sessionId) {
      this.syncReports = {
        ...this.syncReports,
        [player.id]: {
          playerId: player.id,
          sessionId: player.sessionId,
          cursor,
          receivedAt: nowMs,
        },
      }
      this.onChange()
    }

    const cursorIsCurrent =
      cursor !== null &&
      cursor.creatorSessionStartedAt === this.incarnation &&
      cursor.revision === this.state.revision
    if (wantState || !cursorIsCurrent) {
      // Targeted send: keep this player's own draft so a reloaded tab can
      // restore unsubmitted work; everyone else's drafts stay host-only.
      this.send(this.buildState(player.id), peerId)
    }
  }

  private handleRequest(
    message: Extract<ClientMessage, {kind: 'request'}>,
    peerId: string,
  ): void {
    const {requestId, envelope} = message
    const nowMs = this.now()
    this.lastSeenByPlayer.set(envelope.senderId, nowMs)
    this.peerByPlayer.set(envelope.senderId, peerId)

    let result = this.requestResults.get(requestId)
    if (!result) {
      const applied = this.applyEnvelope(envelope)
      result = {
        accepted: applied.accepted,
        seq: applied.next.revision,
        kind: envelope.intent.type,
      }
      this.requestResults.set(requestId, result)
      if (this.requestResults.size > MAX_REQUEST_RESULTS) {
        const draftEntry = Array.from(this.requestResults).find(
          ([, stored]) => stored.kind === 'draft',
        )
        const oldest =
          draftEntry ?? this.requestResults.entries().next().value
        if (oldest) this.requestResults.delete(oldest[0])
      }
      if (applied.changed) {
        this.publish(
          applied.next,
          envelope.intent.type === 'draft' && !applied.stageTransitioned
            ? 'silent'
            : 'now',
        )
      }
    }

    const ack: AckMessage = {
      v: PROTOCOL_VERSION,
      roomCode: this.roomCode,
      kind: 'ack',
      requestId,
      playerId: envelope.senderId,
      sessionId: envelope.sessionId,
      accepted: result.accepted,
      seq: result.seq,
      serverTime: nowMs,
    }
    this.send(ack, peerId)
  }

  private applyEnvelope(envelope: IntentEnvelope): {
    next: RoomState
    changed: boolean
    accepted: boolean
    stageTransitioned: boolean
  } {
    const current = this.state
    const nowMs = this.now()
    const intent = envelope.intent

    // A duplicate draft/submit whose candidate is already recorded counts as
    // accepted even though it no longer changes state.
    const assignment =
      (intent.type === 'draft' || intent.type === 'submit') &&
      current.round?.id === intent.roundId &&
      current.round.stageIndex === intent.stageIndex
        ? current.round.assignments[envelope.senderId]
        : null
    const existing =
      intent.type === 'draft'
        ? assignment?.draft
        : intent.type === 'submit'
          ? assignment?.submission
          : null
    const alreadyApplied = Boolean(
      existing &&
        (intent.type === 'draft' || intent.type === 'submit') &&
        existing.sessionId === intent.candidate.sessionId &&
        existing.seq >= intent.candidate.seq,
    )

    let next = applyIntent(current, envelope, nowMs)
    const accepted = alreadyApplied || next !== current
    if (
      intent.type === 'submit' &&
      next.phase === 'stage' &&
      next.round &&
      getSubmissionCount(next) === next.round.order.length
    ) {
      next = advanceStage(next, nowMs)
    }
    const stageTransitioned =
      next.phase !== current.phase ||
      next.round?.stageIndex !== current.round?.stageIndex
    return {next, changed: next !== current, accepted, stageTransitioned}
  }

  /**
   * 'now' broadcasts immediately, 'defer' batches into the next flush, and
   * 'silent' persists without any broadcast — used for drafts, which are
   * host-internal until the deadline captures them and never appear in
   * wire states.
   */
  private publish(next: RoomState, urgency: 'now' | 'defer' | 'silent'): void {
    this.state = next
    this.persistState?.(next)
    this.onChange()
    if (urgency === 'now') {
      this.broadcastState()
    } else if (urgency === 'defer') {
      this.broadcastDirty = true
    }
  }

  private buildState(keepDraftsFor?: string): StateMessage {
    return {
      v: PROTOCOL_VERSION,
      roomCode: this.roomCode,
      kind: 'state',
      incarnation: this.incarnation,
      seq: this.state.revision,
      serverTime: this.now(),
      state: redactStateForWire(this.state, keepDraftsFor),
    }
  }

  private buildTick(nowMs: number): TickMessage {
    return {
      v: PROTOCOL_VERSION,
      roomCode: this.roomCode,
      kind: 'tick',
      incarnation: this.incarnation,
      hostSessionId: this.player.sessionId,
      seq: this.state.revision,
      serverTime: nowMs,
      phase: this.state.phase,
      deadline:
        this.state.phase === 'stage' && this.state.round
          ? this.state.round.deadline
          : null,
    }
  }

  private broadcastState(): void {
    this.broadcastDirty = false
    this.lastBroadcastAt = this.now()
    this.send(this.buildState())
  }

  private send(message: WireMessage, targetPeerId?: string): void {
    void this.transport.send(message, targetPeerId).catch(() => {
      // Transport failures surface through peer connectivity, not here.
    })
  }

  /** Current cursor of the host itself, used by the sync monitor UI. */
  cursor() {
    return syncCursorForState(this.state)
  }
}
