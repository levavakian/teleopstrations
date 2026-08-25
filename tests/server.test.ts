import {describe, expect, it} from 'vitest'

import {
  CLOSED_ROOM_GRACE_MS,
  ROOM_IDLE_TIMEOUT_MS,
  RoomManager,
  type ManagedClient,
} from '../server/rooms'
import {playerIdForName} from '../src/game'
import type {ServerMessage} from '../src/serverProtocol'
import type {GameIntent, RoomState} from '../src/types'

class FakeClient implements ManagedClient {
  readonly received: ServerMessage[] = []
  closed = false

  send(message: ServerMessage): void {
    this.received.push(message)
  }

  close(): void {
    this.closed = true
  }

  lastOfType<T extends ServerMessage['type']>(
    type: T,
  ): Extract<ServerMessage, {type: T}> | undefined {
    for (let index = this.received.length - 1; index >= 0; index -= 1) {
      const message = this.received[index]
      if (message.type === type) {
        return message as Extract<ServerMessage, {type: T}>
      }
    }
    return undefined
  }

  /** The state this client would currently render. */
  state(): RoomState {
    const message =
      this.lastOfType('state') ?? this.lastOfType('joined')
    if (!message) throw new Error('client never received a state')
    return message.state
  }
}

interface Harness {
  manager: RoomManager
  clock: {now: number}
  join: (
    name: string,
    options?: {create?: boolean; roomCode?: string},
  ) => FakeClient
  intent: (client: FakeClient, intent: GameIntent) => void
}

const ROOM_CODE = 'ABCD2345'

function createHarness(): Harness {
  const clock = {now: 100_000}
  const manager = new RoomManager(() => clock.now)
  let sessionCounter = 0

  const join = (
    name: string,
    options: {create?: boolean; roomCode?: string} = {},
  ): FakeClient => {
    const client = new FakeClient()
    sessionCounter += 1
    manager.handleMessage(client, {
      type: 'join',
      roomCode: options.roomCode ?? ROOM_CODE,
      create: options.create ?? false,
      player: {
        id: playerIdForName(name),
        name,
        sessionId: `session-${name}-${sessionCounter}`,
        sessionStartedAt: clock.now,
      },
      settings: options.create
        ? {promptSeconds: 30, drawingSeconds: 30}
        : undefined,
    })
    return client
  }

  const intent = (client: FakeClient, intent: GameIntent): void => {
    manager.handleMessage(client, {type: 'intent', intent})
  }

  return {manager, clock, join, intent}
}

describe('room lifecycle', () => {
  it('creates a room for the creator and joins guests into it', () => {
    const {join} = createHarness()
    const admin = join('Ada', {create: true})
    expect(admin.lastOfType('joined')).toBeDefined()
    expect(admin.state().creatorId).toBe(playerIdForName('Ada'))

    const guest = join('Bee')
    expect(guest.state().joinOrder).toHaveLength(2)
    // The admin heard about the join through a state broadcast.
    expect(admin.state().players[playerIdForName('Bee')]).toBeDefined()
  })

  it('rejects joins to rooms that do not exist', () => {
    const {join} = createHarness()
    const guest = join('Bee')
    expect(guest.lastOfType('join-error')?.code).toBe('not-found')
  })

  it('lets the creator recreate the room with the same code after a wipe', () => {
    const {join} = createHarness()
    const admin = join('Ada', {create: true})
    expect(admin.state().creatorId).toBe(playerIdForName('Ada'))
    // A "create" join for an existing room simply joins it.
    const again = join('Ada', {create: true})
    expect(again.state().joinOrder).toHaveLength(1)
  })

  it('expires rooms after a day without activity and tells the players', () => {
    const {manager, clock, join} = createHarness()
    const admin = join('Ada', {create: true})
    expect(manager.roomCount).toBe(1)

    clock.now += ROOM_IDLE_TIMEOUT_MS - 1
    manager.pump()
    expect(manager.roomCount).toBe(1)

    clock.now += 2
    manager.pump()
    expect(manager.roomCount).toBe(0)
    expect(admin.state().phase).toBe('closed')
    expect(admin.closed).toBe(true)
  })

  it('keeps a room alive while intents keep arriving', () => {
    const {manager, clock, join, intent} = createHarness()
    const admin = join('Ada', {create: true})
    for (let day = 0; day < 3; day += 1) {
      clock.now += ROOM_IDLE_TIMEOUT_MS - 60_000
      intent(admin, {
        type: 'settings',
        settings: {promptSeconds: 45 + day, drawingSeconds: 60},
      })
      manager.pump()
      expect(manager.roomCount).toBe(1)
    }
  })

  it('deletes an explicitly closed room after the grace period', () => {
    const {manager, clock, join, intent} = createHarness()
    const admin = join('Ada', {create: true})
    intent(admin, {type: 'close-room', roomCode: ROOM_CODE})
    expect(admin.state().phase).toBe('closed')
    expect(manager.roomCount).toBe(1)

    clock.now += CLOSED_ROOM_GRACE_MS + 1
    manager.pump()
    expect(manager.roomCount).toBe(0)
  })
})

describe('admin identity', () => {
  it('makes the rejoining creator the admin again, from any connection', () => {
    const {manager, join, intent} = createHarness()
    const admin = join('Ada', {create: true})
    join('Bee')
    join('Cee')

    // The admin drops; the room keeps running without them.
    manager.disconnect(admin)

    const returned = join('Ada')
    const state = returned.state()
    expect(state.creatorId).toBe(playerIdForName('Ada'))
    expect(state.players[state.creatorId].connected).toBe(true)

    // The returned connection wields admin power (start a round).
    intent(returned, {
      type: 'start-round',
      expectedPhase: 'lobby',
      previousRoundId: null,
    })
    expect(returned.state().phase).toBe('stage')
  })

  it('rejects admin controls from non-admin players', () => {
    const {join, intent} = createHarness()
    join('Ada', {create: true})
    const guest = join('Bee')
    join('Cee')
    intent(guest, {
      type: 'start-round',
      expectedPhase: 'lobby',
      previousRoundId: null,
    })
    expect(guest.state().phase).toBe('lobby')
  })

  it('supersedes an older connection when the same name rejoins', () => {
    const {join} = createHarness()
    const first = join('Ada', {create: true})
    const second = join('Ada')
    expect(first.lastOfType('superseded')).toBeDefined()
    expect(first.closed).toBe(true)
    expect(second.state().joinOrder).toHaveLength(1)
  })

  it('blocks kicked players from rejoining', () => {
    const {join, intent} = createHarness()
    const admin = join('Ada', {create: true})
    join('Bee')
    intent(admin, {
      type: 'kick-player',
      playerId: playerIdForName('Bee'),
      expectedPhase: 'lobby',
      previousRoundId: null,
    })
    const kicked = join('Bee')
    expect(kicked.lastOfType('join-error')?.code).toBe('blocked')
  })
})

describe('gameplay over the wire', () => {
  it('runs a stage: submissions advance, drafts stay server-side until capture', () => {
    const {clock, manager, join, intent} = createHarness()
    const admin = join('Ada', {create: true})
    const bee = join('Bee')
    const cee = join('Cee')
    intent(admin, {
      type: 'start-round',
      expectedPhase: 'lobby',
      previousRoundId: null,
    })
    const round = admin.state().round!
    expect(round.stageIndex).toBe(0)

    // Bee drafts; nobody is told (no broadcast), but the server records it.
    const beeSession = bee.state().players[playerIdForName('Bee')].sessionId
    const statesBefore = cee.received.filter((m) => m.type === 'state').length
    intent(bee, {
      type: 'draft',
      roundId: round.id,
      stageIndex: 0,
      candidate: {
        seq: 1,
        sessionId: beeSession,
        content: {kind: 'text', text: 'Bee work in progress'},
      },
    })
    expect(
      cee.received.filter((m) => m.type === 'state').length,
    ).toBe(statesBefore)
    expect(bee.state().round!.assignments[playerIdForName('Bee')].draft).toBe(
      null,
    )

    // The deadline captures the draft into the book.
    clock.now = round.deadline + 1
    manager.pump()
    const advanced = cee.state()
    expect(advanced.round!.stageIndex).toBe(1)
    expect(
      advanced.round!.books[playerIdForName('Bee')].entries[0],
    ).toMatchObject({
      source: 'draft',
      content: {kind: 'text', text: 'Bee work in progress'},
    })
  })

  it('sends the rejoining player their own draft back for editor restore', () => {
    const {join, intent} = createHarness()
    const admin = join('Ada', {create: true})
    const bee = join('Bee')
    join('Cee')
    intent(admin, {
      type: 'start-round',
      expectedPhase: 'lobby',
      previousRoundId: null,
    })
    const round = admin.state().round!
    const beeSession = bee.state().players[playerIdForName('Bee')].sessionId
    intent(bee, {
      type: 'draft',
      roundId: round.id,
      stageIndex: 0,
      candidate: {
        seq: 1,
        sessionId: beeSession,
        content: {kind: 'text', text: 'Restore me'},
      },
    })

    const reloaded = join('Bee')
    const joined = reloaded.lastOfType('joined')!
    expect(
      joined.state.round!.assignments[playerIdForName('Bee')].draft?.content,
    ).toEqual({kind: 'text', text: 'Restore me'})
    // Other players never see it.
    expect(
      admin.state().round!.assignments[playerIdForName('Bee')].draft,
    ).toBeNull()
  })

  it('advances the stage as soon as everyone submits', () => {
    const {join, intent} = createHarness()
    const admin = join('Ada', {create: true})
    const bee = join('Bee')
    const cee = join('Cee')
    intent(admin, {
      type: 'start-round',
      expectedPhase: 'lobby',
      previousRoundId: null,
    })
    const round = admin.state().round!
    const clients: Array<[FakeClient, string]> = [
      [admin, 'Ada'],
      [bee, 'Bee'],
      [cee, 'Cee'],
    ]
    for (const [client, name] of clients) {
      const sessionId =
        client.state().players[playerIdForName(name)].sessionId
      intent(client, {
        type: 'submit',
        roundId: round.id,
        stageIndex: 0,
        candidate: {
          seq: 1,
          sessionId,
          content: {kind: 'text', text: `${name} prompt`},
        },
      })
    }
    for (const [client] of clients) {
      expect(client.state().round!.stageIndex).toBe(1)
    }
  })

  it('marks players disconnected when their socket drops', () => {
    const {manager, join} = createHarness()
    const admin = join('Ada', {create: true})
    const bee = join('Bee')
    manager.disconnect(bee)
    expect(
      admin.state().players[playerIdForName('Bee')].connected,
    ).toBe(false)
  })

  it('answers pings and includes cursor reports in ticks', () => {
    const {manager, clock, join} = createHarness()
    const admin = join('Ada', {create: true})
    const bee = join('Bee')
    manager.handleMessage(bee, {type: 'ping', id: 'p1', clientTime: 5})
    const pong = bee.lastOfType('pong')
    expect(pong).toMatchObject({id: 'p1', clientTime: 5})

    const cursor = {
      creatorId: playerIdForName('Ada'),
      creatorSessionId: bee.state().players[playerIdForName('Ada')].sessionId,
      creatorSessionStartedAt:
        bee.state().players[playerIdForName('Ada')].sessionStartedAt,
      revision: bee.state().revision,
      phase: 'lobby' as const,
      roundId: null,
      roundNumber: null,
      stageIndex: null,
      revealBookIndex: null,
      revealPageIndex: null,
      revealComplete: null,
    }
    manager.handleMessage(bee, {type: 'cursor', cursor})
    clock.now += 1_001
    manager.pump()
    const tick = admin.lastOfType('tick')
    expect(tick?.reports[playerIdForName('Bee')]?.cursor.revision).toBe(
      cursor.revision,
    )
  })
})
