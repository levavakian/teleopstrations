import {
  advanceStage,
  applyIntent,
  closeRoom,
  createInitialRoom,
  getSubmissionCount,
  isValidSettings,
  joinPlayer,
  normalizeName,
  normalizeRoomCode,
  playerIdForName,
  redactStateForWire,
  setPlayerConnected,
} from '../src/game'
import {
  parseClientMessage,
  type ClientMessage,
  type JoinMessage,
  type ServerMessage,
} from '../src/serverProtocol'
import type {
  IntentEnvelope,
  PeerSyncReport,
  PlayerId,
  PlayerSession,
  RoomState,
} from '../src/types'

/** Rooms with no human action (join or intent) for this long are deleted. */
export const ROOM_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000
/** Explicitly closed rooms linger briefly so clients render the shutdown screen. */
export const CLOSED_ROOM_GRACE_MS = 60_000
export const TICK_INTERVAL_MS = 1_000

/** Transport-facing side of a connection; the ws layer adapts real sockets. */
export interface ManagedClient {
  send(message: ServerMessage): void
  close(): void
}

interface Connection {
  roomCode: string
  session: PlayerSession
}

interface Room {
  state: RoomState
  clients: Set<ManagedClient>
  reports: Record<PlayerId, PeerSyncReport>
  lastActivityAt: number
  lastTickAt: number
}

/**
 * Owns every room's canonical state, entirely in memory. Applies intents
 * serially through the shared game reducer and pushes redacted state to all
 * connected clients on every visible change. The admin is the room creator;
 * identity is name-based, so rejoining with the creator's name is enough to
 * be the admin again.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>()
  private readonly connections = new Map<ManagedClient, Connection>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  get roomCount(): number {
    return this.rooms.size
  }

  handleMessage(client: ManagedClient, raw: unknown): void {
    const message = parseClientMessage(raw)
    if (!message) return
    switch (message.type) {
      case 'join':
        this.handleJoin(client, message)
        return
      case 'intent':
        this.handleIntent(client, message)
        return
      case 'cursor':
        this.handleCursor(client, message)
        return
      case 'ping':
        client.send({
          type: 'pong',
          id: message.id,
          clientTime: message.clientTime,
          serverTime: this.now(),
        })
        return
    }
  }

  disconnect(client: ManagedClient): void {
    const connection = this.connections.get(client)
    if (!connection) return
    this.connections.delete(client)
    const room = this.rooms.get(connection.roomCode)
    if (!room) return
    room.clients.delete(client)
    // Only mark offline if no other connection still holds this seat.
    const playerId = connection.session.id
    const stillConnected = Array.from(room.clients).some(
      (other) => this.connections.get(other)?.session.id === playerId,
    )
    if (!stillConnected && room.state.players[playerId]) {
      const next = setPlayerConnected(room.state, playerId, false)
      if (next !== room.state) {
        room.state = next
        this.broadcastState(room)
      }
    }
  }

  /** Advances stage deadlines, sends ticks, and cleans up idle rooms. */
  pump(nowMs: number = this.now()): void {
    for (const [code, room] of this.rooms) {
      if (
        room.state.phase === 'closed' &&
        room.state.closedAt !== null &&
        nowMs - room.state.closedAt >= CLOSED_ROOM_GRACE_MS
      ) {
        this.deleteRoom(code, room)
        continue
      }
      if (nowMs - room.lastActivityAt >= ROOM_IDLE_TIMEOUT_MS) {
        // Expire the room: broadcast the closed state so open tabs show the
        // shutdown screen, then drop everything from memory.
        room.state = closeRoom(room.state, nowMs)
        this.broadcastState(room)
        this.deleteRoom(code, room)
        continue
      }
      if (
        room.state.phase === 'stage' &&
        room.state.round &&
        nowMs >= room.state.round.deadline
      ) {
        room.state = advanceStage(room.state, nowMs)
        this.broadcastState(room)
      }
      if (nowMs - room.lastTickAt >= TICK_INTERVAL_MS) {
        room.lastTickAt = nowMs
        const tick: ServerMessage = {
          type: 'tick',
          serverTime: nowMs,
          reports: room.reports,
        }
        for (const client of room.clients) client.send(tick)
      }
    }
  }

  private handleJoin(client: ManagedClient, message: JoinMessage): void {
    const nowMs = this.now()
    const roomCode = normalizeRoomCode(message.roomCode)
    const name = normalizeName(message.player.name)
    if (roomCode.length !== 8 || !name) {
      client.send({
        type: 'join-error',
        code: 'invalid',
        message: 'That room code or name is not usable.',
      })
      return
    }
    const playerId = playerIdForName(name)

    let room = this.rooms.get(roomCode)
    if (!room) {
      if (
        !message.create ||
        !message.settings ||
        !isValidSettings(message.settings)
      ) {
        client.send({
          type: 'join-error',
          code: 'not-found',
          message:
            'This room is not live. It may have expired, or the server may have restarted — the creator can bring it back by reopening their tab or creating it again.',
        })
        return
      }
      const creator: PlayerSession = {
        id: playerId,
        name,
        sessionId: message.player.sessionId,
        sessionStartedAt: nowMs,
      }
      room = {
        state: createInitialRoom(roomCode, creator, message.settings),
        clients: new Set(),
        reports: {},
        lastActivityAt: nowMs,
        lastTickAt: nowMs,
      }
      this.rooms.set(roomCode, room)
    }

    if (room.state.blockedPlayerIds.includes(playerId)) {
      client.send({
        type: 'join-error',
        code: 'blocked',
        message: 'You have been removed from this room.',
      })
      return
    }

    // Server-stamped session start guarantees the newest connection always
    // wins the seat, regardless of device clock skew. This is also what
    // makes "rejoin with the creator's name to become admin again" work:
    // identity is the name, and the latest claim on it takes the seat.
    const existing = room.state.players[playerId]
    const session: PlayerSession = {
      id: playerId,
      name,
      sessionId: message.player.sessionId,
      sessionStartedAt: existing
        ? Math.max(nowMs, existing.sessionStartedAt + 1)
        : nowMs,
    }
    const next = joinPlayer(room.state, session)
    if (next === room.state && !existing) {
      // joinPlayer refused (e.g. the room closed between checks).
      client.send({
        type: 'join-error',
        code: 'not-found',
        message: 'This room has been shut down.',
      })
      return
    }

    // Hand the seat over: any other connection for this player is done.
    for (const other of room.clients) {
      if (other === client) continue
      if (this.connections.get(other)?.session.id === playerId) {
        other.send({type: 'superseded'})
        room.clients.delete(other)
        this.connections.delete(other)
        other.close()
      }
    }

    room.state = next
    room.lastActivityAt = nowMs
    this.connections.set(client, {roomCode, session})
    room.clients.add(client)

    client.send({
      type: 'joined',
      state: redactStateForWire(room.state, playerId),
      serverTime: nowMs,
    })
    this.broadcastState(room, client)
  }

  private handleIntent(
    client: ManagedClient,
    message: Extract<ClientMessage, {type: 'intent'}>,
  ): void {
    const connection = this.connections.get(client)
    if (!connection) return
    const room = this.rooms.get(connection.roomCode)
    if (!room) return
    const nowMs = this.now()
    room.lastActivityAt = nowMs

    const envelope: IntentEnvelope = {
      id: crypto.randomUUID(),
      senderId: connection.session.id,
      sessionId: connection.session.sessionId,
      intent: message.intent,
    }
    const current = room.state
    let next = applyIntent(current, envelope, nowMs)
    if (
      envelope.intent.type === 'submit' &&
      next.phase === 'stage' &&
      next.round &&
      getSubmissionCount(next) === next.round.order.length
    ) {
      next = advanceStage(next, nowMs)
    }
    if (next === current) return
    const stageTransitioned =
      next.phase !== current.phase ||
      next.round?.stageIndex !== current.round?.stageIndex
    room.state = next
    // Drafts are server-internal until the deadline captures them; they
    // trigger no broadcast, so drawing strokes cost almost no bandwidth.
    if (envelope.intent.type === 'draft' && !stageTransitioned) return
    this.broadcastState(room)
  }

  private handleCursor(
    client: ManagedClient,
    message: Extract<ClientMessage, {type: 'cursor'}>,
  ): void {
    const connection = this.connections.get(client)
    if (!connection) return
    const room = this.rooms.get(connection.roomCode)
    if (!room) return
    const player = room.state.players[connection.session.id]
    if (!player || player.sessionId !== connection.session.sessionId) return
    room.reports[connection.session.id] = {
      playerId: connection.session.id,
      sessionId: connection.session.sessionId,
      cursor: message.cursor,
      receivedAt: this.now(),
    }
  }

  private broadcastState(room: Room, except?: ManagedClient): void {
    const message: ServerMessage = {
      type: 'state',
      state: redactStateForWire(room.state),
      serverTime: this.now(),
    }
    for (const client of room.clients) {
      if (client !== except) client.send(message)
    }
  }

  private deleteRoom(code: string, room: Room): void {
    for (const client of room.clients) {
      this.connections.delete(client)
      client.close()
    }
    room.clients.clear()
    this.rooms.delete(code)
  }
}
