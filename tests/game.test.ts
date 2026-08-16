import {describe, expect, it} from 'vitest'

import {
  advanceStage,
  applyIntent,
  createInitialRoom,
  getAssignment,
  joinPlayer,
  playerIdForName,
  reclaimCreatorSession,
  redactStateForWire,
  startRound,
} from '../src/game'
import {hostIncarnationOf, isNewerHostState} from '../src/protocol'
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
  return {
    id,
    name,
    sessionId: `session-${id}`,
    sessionStartedAt: 1_000,
  }
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
    const replacement = {
      ...player('Player 2'),
      sessionId: 'replacement-tab',
      sessionStartedAt: 2_000,
    }
    const joined = joinPlayer(state, replacement)

    expect(joined.joinOrder).toHaveLength(3)
    expect(joined.players[replacement.id].sessionId).toBe('replacement-tab')
  })

  it('ignores an older tab after a newer same-name session takes over', () => {
    const {state} = roomWithPlayers(3)
    const current = {
      ...player('Player 2'),
      sessionId: 'new-tab',
      sessionStartedAt: 2_000,
    }
    const reclaimed = joinPlayer(state, current)
    const stalePresence = player('Player 2')

    expect(joinPlayer(reclaimed, stalePresence)).toBe(reclaimed)
    expect(reclaimed.players[current.id].sessionId).toBe('new-tab')
  })
})

describe('book rotation and finalization', () => {
  it.each([3, 4, 5])(
    'shows each player a distinct predecessor fallback prompt (%i players)',
    (count) => {
      const {state} = roomWithPlayers(count)
      const started = startRound(state, 10_000, () => 0.999)
      const order = started.round!.order
      // Nobody submits an opening prompt; the deadline fires.
      const drawing = advanceStage(started, 80_000)

      const seenSources = new Set<string>()
      for (const [index, playerId] of order.entries()) {
        const assignment = drawing.round!.assignments[playerId]
        const predecessor = order[(index - 1 + count) % count]
        expect(assignment.bookOwnerId).toBe(predecessor)
        const source =
          drawing.round!.books[assignment.bookOwnerId].entries[0]
        expect(source.content).toEqual({
          kind: 'text',
          text: `${drawing.players[predecessor].name} did not submit a prompt in time, draw what you think of them`,
        })
        seenSources.add(assignment.bookOwnerId)
      }
      // Every player draws a different book: no duplicated prompts.
      expect(seenSources.size).toBe(count)
    },
  )

  it.each([3, 4, 5, 8, 20])(
    'rotates authors correctly for %i players',
    (count) => {
      const {state} = roomWithPlayers(count)
      let current = startRound(state, 10_000, () => 0.999)
      const order = current.round!.order

      for (let stage = 0; stage < count; stage += 1) {
        current = advanceStage(current, 20_000 + stage * 1_000)
      }

      for (let ownerIndex = 0; ownerIndex < count; ownerIndex += 1) {
        expect(
          current.round!.books[order[ownerIndex]].entries.map(
            ({authorId}) => authorId,
          ),
        ).toEqual(
          Array.from(
            {length: count},
            (_, stage) => order[(ownerIndex + stage) % count],
          ),
        )
      }
    },
  )

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

  it('records drafts without bumping the client-visible revision', () => {
    const {state, sessions} = roomWithPlayers(3)
    const started = startRound(state, 10_000, () => 0.999)
    const self = sessions[0]

    const drafted = applyIntent(
      started,
      envelope(self, {
        type: 'draft',
        roundId: started.round!.id,
        stageIndex: 0,
        candidate: candidate(self, 1, {kind: 'text', text: 'Typing…'}),
      }),
      11_000,
    )
    // The draft is recorded for deadline capture but is host-internal:
    // no broadcast happens, so the revision must not move either.
    expect(drafted.round!.assignments[self.id].draft?.content).toEqual({
      kind: 'text',
      text: 'Typing…',
    })
    expect(drafted.revision).toBe(started.revision)

    const submitted = submitForCurrentStage(drafted, self, {
      kind: 'text',
      text: 'Final',
    })
    expect(submitted.revision).toBe(started.revision + 1)
  })

  it('strips foreign drafts from wire states but keeps the recipient’s own', () => {
    const {state, sessions} = roomWithPlayers(3)
    let current = startRound(state, 10_000, () => 0.999)
    const [alpha, beta] = sessions

    for (const [session, text] of [
      [alpha, 'Alpha draft'],
      [beta, 'Beta draft'],
    ] as const) {
      current = applyIntent(
        current,
        envelope(session, {
          type: 'draft',
          roundId: current.round!.id,
          stageIndex: 0,
          candidate: candidate(session, 1, {kind: 'text', text}),
        }),
        11_000,
      )
    }
    current = submitForCurrentStage(current, beta, {
      kind: 'text',
      text: 'Beta submitted',
    })

    const broadcast = redactStateForWire(current)
    expect(broadcast.round!.assignments[alpha.id].draft).toBeNull()
    expect(broadcast.round!.assignments[beta.id].draft).toBeNull()
    // Submissions are client-visible state and survive redaction.
    expect(
      broadcast.round!.assignments[beta.id].submission?.content,
    ).toEqual({kind: 'text', text: 'Beta submitted'})

    const targeted = redactStateForWire(current, alpha.id)
    expect(targeted.round!.assignments[alpha.id].draft?.content).toEqual({
      kind: 'text',
      text: 'Alpha draft',
    })
    expect(targeted.round!.assignments[beta.id].draft).toBeNull()

    // The redacted copy must never alias the host's canonical state.
    expect(current.round!.assignments[alpha.id].draft?.content).toEqual({
      kind: 'text',
      text: 'Alpha draft',
    })

    // Without drafts to hide, the state passes through untouched.
    const clean = advanceStage(current, 80_000)
    expect(redactStateForWire(clean)).toBe(clean)
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

describe('creator authority', () => {
  it('rejects creator controls from non-creator players', () => {
    const {state, sessions} = roomWithPlayers(3)
    const attempted = applyIntent(
      state,
      envelope(sessions[1], {
        type: 'start-round',
        expectedPhase: 'lobby',
        previousRoundId: null,
      }),
      10_000,
    )
    expect(attempted).toBe(state)
  })

  it('resumes hosting under a strictly newer incarnation', () => {
    const {state, sessions} = roomWithPlayers(3)
    const recovered = reclaimCreatorSession(state, {
      ...sessions[0],
      sessionId: 'creator-recovered',
      sessionStartedAt: 2_000,
    })

    expect(recovered.creatorId).toBe(sessions[0].id)
    expect(recovered.players[recovered.creatorId].sessionId).toBe(
      'creator-recovered',
    )
    expect(hostIncarnationOf(recovered)).toBeGreaterThan(
      hostIncarnationOf(state),
    )
  })

  it('orders host output by incarnation before sequence', () => {
    expect(isNewerHostState(null, {incarnation: 1, seq: 0})).toBe(true)
    expect(
      isNewerHostState({incarnation: 1, seq: 5}, {incarnation: 1, seq: 6}),
    ).toBe(true)
    expect(
      isNewerHostState({incarnation: 1, seq: 5}, {incarnation: 1, seq: 5}),
    ).toBe(false)
    expect(
      isNewerHostState({incarnation: 1, seq: 5}, {incarnation: 1, seq: 4}),
    ).toBe(false)
    expect(
      isNewerHostState({incarnation: 1, seq: 900}, {incarnation: 2, seq: 0}),
    ).toBe(true)
    expect(
      isNewerHostState({incarnation: 2, seq: 0}, {incarnation: 1, seq: 900}),
    ).toBe(false)
  })

  it('keeps a resumed round deadline at least twenty seconds out', () => {
    const {state, sessions} = roomWithPlayers(3)
    const started = startRound(state, 10_000, () => 0.999)
    const resumed = reclaimCreatorSession(
      started,
      {...sessions[0], sessionId: 'next', sessionStartedAt: 2_000},
      50_000,
    )
    expect(resumed.round!.deadline).toBeGreaterThanOrEqual(70_000)
  })

  it('rejects oversized client content', () => {
    const {state, sessions} = roomWithPlayers(3)
    const started = startRound(state, 10_000, () => 0.999)
    const attempted = applyIntent(
      started,
      envelope(sessions[0], {
        type: 'submit',
        roundId: started.round!.id,
        stageIndex: 0,
        candidate: candidate(sessions[0], 1, {
          kind: 'text',
          text: 'x'.repeat(281),
        }),
      }),
      11_000,
    )
    expect(attempted).toBe(started)
  })

  it('rejects a duplicate force-advance after its stage has changed', () => {
    const {state, sessions} = roomWithPlayers(3)
    const started = startRound(state, 10_000, () => 0.999)
    const force = envelope(sessions[0], {
      type: 'force-advance',
      roundId: started.round!.id,
      stageIndex: 0,
    })
    const advanced = applyIntent(started, force, 11_000)

    expect(advanced.round?.stageIndex).toBe(1)
    expect(applyIntent(advanced, force, 12_000)).toBe(advanced)
  })

  it('cannot start a replacement round while a stage is active', () => {
    const {state, sessions} = roomWithPlayers(3)
    const started = startRound(state, 10_000, () => 0.999)
    const replacement = applyIntent(
      started,
      envelope(sessions[0], {
        type: 'start-round',
        expectedPhase: 'lobby',
        previousRoundId: null,
      }),
      11_000,
    )

    expect(replacement).toBe(started)
  })

  it('ends an active round by finalizing its current stage for reveal', () => {
    const {state, sessions} = roomWithPlayers(3)
    let started = startRound(state, 10_000, () => 0.999)
    started = applyIntent(
      started,
      envelope(sessions[0], {
        type: 'draft',
        roundId: started.round!.id,
        stageIndex: 0,
        candidate: candidate(sessions[0], 1, {
          kind: 'text',
          text: 'Reveal this early',
        }),
      }),
      11_000,
    )
    const ended = applyIntent(
      started,
      envelope(sessions[0], {
        type: 'end-round',
        roundId: started.round!.id,
        stageIndex: 0,
      }),
      12_000,
    )

    expect(ended.phase).toBe('reveal')
    expect(ended.round?.reveal).toEqual({
      bookIndex: 0,
      pageIndex: 0,
      complete: false,
    })
    expect(ended.round?.books[sessions[0].id].entries).toHaveLength(1)
  })

  it('kicks and blocks a player only between rounds', () => {
    const {state, sessions} = roomWithPlayers(3)
    const kicked = applyIntent(
      state,
      envelope(sessions[0], {
        type: 'kick-player',
        playerId: sessions[2].id,
        expectedPhase: 'lobby',
        previousRoundId: null,
      }),
      10_000,
    )

    expect(kicked.joinOrder).not.toContain(sessions[2].id)
    expect(kicked.blockedPlayerIds).toContain(sessions[2].id)
    expect(kicked.players[sessions[2].id].connected).toBe(false)
    expect(
      joinPlayer(kicked, {
        ...sessions[2],
        sessionId: 'attempted-return',
        sessionStartedAt: 3_000,
      }),
    ).toBe(kicked)

    const active = startRound(state, 10_000, () => 0.999)
    const rejected = applyIntent(
      active,
      envelope(sessions[0], {
        type: 'kick-player',
        playerId: sessions[2].id,
        expectedPhase: 'lobby',
        previousRoundId: null,
      }),
      11_000,
    )
    expect(rejected).toBe(active)
  })

  it('closes a room and removes its active round data', () => {
    const {state, sessions} = roomWithPlayers(3)
    const started = startRound(state, 10_000, () => 0.999)
    const closed = applyIntent(
      started,
      envelope(sessions[0], {
        type: 'close-room',
        roomCode: started.roomCode,
      }),
      12_345,
    )

    expect(closed.phase).toBe('closed')
    expect(closed.round).toBeNull()
    expect(closed.closedAt).toBe(12_345)
  })

  it('migrates an existing assignment when its player rejoins', () => {
    const {state, sessions} = roomWithPlayers(3)
    let started = startRound(state, 10_000, () => 0.999)
    started = submitForCurrentStage(
      started,
      sessions[1],
      {kind: 'text', text: 'Keep me'},
      7,
    )
    const replacement = {
      ...sessions[1],
      sessionId: 'new-session',
      sessionStartedAt: 2_000,
    }
    const rejoined = joinPlayer(started, replacement)
    const submission = getAssignment(rejoined, sessions[1].id)?.submission

    expect(submission).toMatchObject({
      seq: 0,
      sessionId: 'new-session',
      content: {kind: 'text', text: 'Keep me'},
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
      envelope(unauthorized, {
        type: 'reveal-page',
        roundId: current.round!.id,
        bookIndex: 0,
        pageIndex: 1,
      }),
      41_000,
    )
    expect(rejected).toBe(current)

    const accepted = applyIntent(
      current,
      envelope(owner, {
        type: 'reveal-page',
        roundId: current.round!.id,
        bookIndex: 0,
        pageIndex: 1,
      }),
      41_000,
    )
    expect(accepted.round?.reveal?.pageIndex).toBe(1)
  })
})
