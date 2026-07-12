import {describe, expect, it} from 'vitest'

import {
  advanceStage,
  applyIntent,
  createInitialRoom,
  electAdmin,
  getAssignment,
  joinPlayer,
  mergeReplica,
  nextAdminCandidate,
  playerIdForName,
  setPlayerConnected,
  startRound,
} from '../src/game'
import type {
  Candidate,
  Content,
  GameIntent,
  IntentEnvelope,
  PlayerSession,
  RoomState,
} from '../src/types'

function player(name: string): PlayerSession {
  const id = playerIdForName(name)
  return {id, name, sessionId: `session-${id}`}
}

function roomWithPlayers(count: number): {
  state: RoomState
  sessions: PlayerSession[]
} {
  const sessions = Array.from({length: count}, (_, index) =>
    player(`Player ${index + 1}`),
  )
  let state = createInitialRoom(
    'ABCD1234',
    sessions[0],
    {promptSeconds: 60, drawingSeconds: 120},
  )
  for (const session of sessions.slice(1)) state = joinPlayer(state, session)
  return {state, sessions}
}

function envelope(
  session: PlayerSession,
  intent: GameIntent,
): IntentEnvelope {
  return {
    id: crypto.randomUUID(),
    senderId: session.id,
    sessionId: session.sessionId,
    intent,
  }
}

function candidate(
  session: PlayerSession,
  seq: number,
  content: Content,
): Candidate {
  return {sessionId: session.sessionId, seq, content}
}

function submitForCurrentStage(
  state: RoomState,
  session: PlayerSession,
  content: Content,
  seq = 1,
): RoomState {
  return applyIntent(
    state,
    envelope(session, {
      type: 'submit',
      roundId: state.round!.id,
      stageIndex: state.round!.stageIndex,
      candidate: candidate(session, seq, content),
    }),
    1_000,
  )
}

describe('room and round lifecycle', () => {
  it('accepts positive integer timers without an upper limit', () => {
    const creator = player('Host')
    const state = createInitialRoom(
      'ABCD1234',
      creator,
      {promptSeconds: 99_999, drawingSeconds: 1},
    )
    expect(state.settings).toEqual({
      promptSeconds: 99_999,
      drawingSeconds: 1,
    })
  })

  it('has no configured maximum and shuffles every connected player', () => {
    const {state} = roomWithPlayers(50)
    const started = startRound(state, 10_000, () => 0.999)
    expect(started.phase).toBe('stage')
    expect(started.round?.order).toHaveLength(50)
    expect(new Set(started.round?.order).size).toBe(50)
  })

  it('requires at least three connected players', () => {
    const {state} = roomWithPlayers(2)
    expect(startRound(state, 10_000)).toBe(state)
  })

  it('freezes the round roster and leaves later players pending', () => {
    const {state, sessions} = roomWithPlayers(3)
    const started = startRound(state, 10_000, () => 0.999)
    const late = player('Late arrival')
    const joined = joinPlayer(started, late)

    expect(joined.round?.order).toEqual(sessions.map(({id}) => id))
    expect(joined.round?.order).not.toContain(late.id)
    expect(joined.players[late.id].connected).toBe(true)
  })

  it('reclaims an existing name without adding another roster entry', () => {
    const {state} = roomWithPlayers(3)
    const replacement = {...player('Player 2'), sessionId: 'replacement-tab'}
    const joined = joinPlayer(state, replacement)

    expect(joined.joinOrder).toHaveLength(3)
    expect(joined.players[replacement.id].sessionId).toBe('replacement-tab')
  })
})

describe('book rotation and finalization', () => {
  it('rotates every book through every other player and alternates content', () => {
    const {state, sessions} = roomWithPlayers(3)
    let current = startRound(state, 10_000, () => 0.999)
    const order = current.round!.order

    for (const session of sessions) {
      current = submitForCurrentStage(current, session, {
        kind: 'text',
        text: `Prompt from ${session.name}`,
      })
    }
    current = advanceStage(current, 20_000)

    for (const session of sessions) {
      current = submitForCurrentStage(current, session, {
        kind: 'drawing',
        strokes: [
          {
            id: `stroke-${session.id}`,
            color: 3,
            size: 2,
            points: [{x: 0.2, y: 0.3, pressure: 0.5}],
          },
        ],
      })
    }
    current = advanceStage(current, 30_000)

    for (const session of sessions) {
      current = submitForCurrentStage(current, session, {
        kind: 'text',
        text: `Guess from ${session.name}`,
      })
    }
    current = advanceStage(current, 40_000)

    expect(current.phase).toBe('reveal')
    for (let ownerIndex = 0; ownerIndex < order.length; ownerIndex += 1) {
      const entries = current.round!.books[order[ownerIndex]].entries
      expect(entries.map(({content}) => content.kind)).toEqual([
        'text',
        'drawing',
        'text',
      ])
      expect(entries.map(({authorId}) => authorId)).toEqual([
        order[ownerIndex],
        order[(ownerIndex + 1) % order.length],
        order[(ownerIndex + 2) % order.length],
      ])
    }
  })

  it('uses the required fallback for an empty opening prompt', () => {
    const {state, sessions} = roomWithPlayers(3)
    const started = startRound(state, 10_000, () => 0.999)
    const finalized = advanceStage(started, 20_000)
    const entry = finalized.round!.books[sessions[0].id].entries[0]

    expect(entry.source).toBe('fallback')
    expect(entry.content).toEqual({
      kind: 'text',
      text: 'Player 1 did not submit a prompt in time, draw what you think of them',
    })
  })

  it('keeps a stage open and chooses the latest explicit resubmission', () => {
    const {state, sessions} = roomWithPlayers(3)
    let current = startRound(state, 10_000, () => 0.999)
    const self = sessions[0]
    const roundId = current.round!.id

    current = applyIntent(
      current,
      envelope(self, {
        type: 'submit',
        roundId,
        stageIndex: 0,
        candidate: candidate(self, 1, {kind: 'text', text: 'First'}),
      }),
      11_000,
    )
    current = applyIntent(
      current,
      envelope(self, {
        type: 'draft',
        roundId,
        stageIndex: 0,
        candidate: candidate(self, 2, {
          kind: 'text',
          text: 'Unsubmitted later edit',
        }),
      }),
      12_000,
    )
    current = applyIntent(
      current,
      envelope(self, {
        type: 'submit',
        roundId,
        stageIndex: 0,
        candidate: candidate(self, 3, {kind: 'text', text: 'Final'}),
      }),
      13_000,
    )

    expect(current.round?.stageIndex).toBe(0)
    const finalized = advanceStage(current, 70_000)
    expect(finalized.round!.books[self.id].entries[0]).toMatchObject({
      source: 'submission',
      content: {kind: 'text', text: 'Final'},
    })
  })

  it('uses the latest synchronized draft when no submission exists', () => {
    const {state, sessions} = roomWithPlayers(3)
    let current = startRound(state, 10_000, () => 0.999)
    const self = sessions[0]

    current = applyIntent(
      current,
      envelope(self, {
        type: 'draft',
        roundId: current.round!.id,
        stageIndex: 0,
        candidate: candidate(self, 4, {
          kind: 'text',
          text: 'Deadline draft',
        }),
      }),
      12_000,
    )

    const finalized = advanceStage(current, 70_000)
    expect(finalized.round!.books[self.id].entries[0]).toMatchObject({
      source: 'draft',
      content: {kind: 'text', text: 'Deadline draft'},
    })
  })
})

describe('replication and administration', () => {
  it('elects the next connected player in frozen round order', () => {
    const {state, sessions} = roomWithPlayers(4)
    let started = startRound(state, 10_000, () => 0.999)
    started = setPlayerConnected(started, sessions[1].id, false)
    const candidate = nextAdminCandidate(
      started,
      new Set([sessions[2].id, sessions[3].id]),
    )

    expect(candidate).toBe(sessions[2].id)
    const elected = electAdmin(started, candidate!)
    expect(elected.adminId).toBe(sessions[2].id)
    expect(elected.adminEpoch).toBe(1)
  })

  it('merges a newer backed-up draft into an authoritative snapshot', () => {
    const {state, sessions} = roomWithPlayers(3)
    const authoritative = startRound(state, 10_000, () => 0.999)
    const local = structuredClone(authoritative)
    const assignment = getAssignment(local, sessions[1].id)!
    assignment.draft = candidate(sessions[1], 9, {
      kind: 'text',
      text: 'Replicated backup',
    })

    const merged = mergeReplica(local, authoritative)
    expect(getAssignment(merged, sessions[1].id)?.draft?.content).toEqual({
      kind: 'text',
      text: 'Replicated backup',
    })
  })

  it('allows only the current book owner or creator to move reveal pages', () => {
    const {state, sessions} = roomWithPlayers(3)
    let current = startRound(state, 10_000, () => 0.999)
    current = advanceStage(current, 20_000)
    current = advanceStage(current, 30_000)
    current = advanceStage(current, 40_000)

    const ownerId = current.round!.order[0]
    const owner = sessions.find(({id}) => id === ownerId)!
    const unauthorized = sessions.find(
      ({id}) => id !== ownerId && id !== current.creatorId,
    )!

    const rejected = applyIntent(
      current,
      envelope(unauthorized, {type: 'reveal-page', pageIndex: 1}),
      41_000,
    )
    expect(rejected).toBe(current)

    const accepted = applyIntent(
      current,
      envelope(owner, {type: 'reveal-page', pageIndex: 1}),
      41_000,
    )
    expect(accepted.round?.reveal?.pageIndex).toBe(1)
  })
})
