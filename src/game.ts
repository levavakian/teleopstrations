import type {
  Assignment,
  Book,
  Candidate,
  Content,
  GameIntent,
  GameSettings,
  IntentEnvelope,
  Player,
  PlayerId,
  PlayerSession,
  RoomState,
  RoundState,
  StageKind,
  SyncCursor,
} from './types'

export const DEFAULT_SETTINGS: GameSettings = {
  promptSeconds: 60,
  drawingSeconds: 120,
}

export const MIN_PLAYERS = 3
export const MAX_ROOM_STATE_CHARS = 3_500_000
export const MAX_TIMER_SECONDS = 8_000_000_000_000

export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

export function playerIdForName(name: string): PlayerId {
  return normalizeName(name).toLocaleLowerCase('en-US')
}

export function normalizeRoomCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

export function displayRoomCode(code: string): string {
  const normalized = normalizeRoomCode(code)
  return normalized.length > 4
    ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
    : normalized
}

export function createRoomCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  const values = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('')
}

export function createId(): string {
  return crypto.randomUUID()
}

export function isValidSettings(settings: GameSettings): boolean {
  return (
    Number.isSafeInteger(settings.promptSeconds) &&
    settings.promptSeconds > 0 &&
    settings.promptSeconds <= MAX_TIMER_SECONDS &&
    Number.isSafeInteger(settings.drawingSeconds) &&
    settings.drawingSeconds > 0 &&
    settings.drawingSeconds <= MAX_TIMER_SECONDS
  )
}

export function hydrateRoomState(state: RoomState): RoomState {
  return {
    ...state,
    protocolVersion: 2,
    blockedPlayerIds: state.blockedPlayerIds ?? [],
    closedAt: state.closedAt ?? null,
  }
}

export function syncCursorForState(state: RoomState): SyncCursor {
  const creator = state.players[state.creatorId]
  return {
    creatorId: state.creatorId,
    creatorSessionId: creator.sessionId,
    creatorSessionStartedAt: creator.sessionStartedAt,
    revision: state.revision,
    phase: state.phase,
    roundId: state.round?.id ?? null,
    roundNumber: state.round?.number ?? null,
    stageIndex: state.round?.stageIndex ?? null,
    revealBookIndex: state.round?.reveal?.bookIndex ?? null,
    revealPageIndex: state.round?.reveal?.pageIndex ?? null,
    revealComplete: state.round?.reveal?.complete ?? null,
  }
}

export function isSyncCursorAhead(
  remote: SyncCursor,
  local: SyncCursor,
): boolean {
  if (remote.creatorId !== local.creatorId) return true
  if (remote.creatorSessionStartedAt !== local.creatorSessionStartedAt) {
    return remote.creatorSessionStartedAt > local.creatorSessionStartedAt
  }
  if (remote.creatorSessionId !== local.creatorSessionId) {
    return remote.creatorSessionId > local.creatorSessionId
  }
  if (remote.revision !== local.revision) return remote.revision > local.revision
  if (
    remote.roundNumber !== local.roundNumber &&
    remote.roundNumber !== null &&
    local.roundNumber !== null
  ) {
    return remote.roundNumber > local.roundNumber
  }
  if (remote.roundId !== local.roundId) return true
  if (
    remote.stageIndex !== local.stageIndex &&
    remote.stageIndex !== null &&
    local.stageIndex !== null
  ) {
    return remote.stageIndex > local.stageIndex
  }
  if (
    remote.revealBookIndex !== local.revealBookIndex &&
    remote.revealBookIndex !== null &&
    local.revealBookIndex !== null
  ) {
    return remote.revealBookIndex > local.revealBookIndex
  }
  return (
    remote.revealPageIndex !== local.revealPageIndex &&
    remote.revealPageIndex !== null &&
    local.revealPageIndex !== null &&
    remote.revealPageIndex > local.revealPageIndex
  ) || (remote.revealComplete === true && local.revealComplete === false)
}

export function isCreatorAuthoritativeSnapshot(
  state: RoomState,
  senderId: PlayerId,
  sessionId: string,
): boolean {
  return (
    senderId === state.creatorId &&
    sessionId === state.players[state.creatorId]?.sessionId
  )
}

function copyState(state: RoomState): RoomState {
  return structuredClone(state)
}

function stageKind(stageIndex: number): StageKind {
  return stageIndex % 2 === 0 ? 'text' : 'drawing'
}

function stageDuration(state: RoomState, stageIndex: number): number {
  return (
    (stageKind(stageIndex) === 'text'
      ? state.settings.promptSeconds
      : state.settings.drawingSeconds) * 1_000
  )
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

function makeAssignments(
  order: PlayerId[],
  stageIndex: number,
): Record<PlayerId, Assignment> {
  return Object.fromEntries(
    order.map((playerId, playerIndex) => {
      const ownerIndex =
        (playerIndex - stageIndex + order.length) % order.length
      return [
        playerId,
        {
          playerId,
          bookOwnerId: order[ownerIndex],
          kind: stageKind(stageIndex),
          draft: null,
          submission: null,
        } satisfies Assignment,
      ]
    }),
  )
}

export function createInitialRoom(
  roomCode: string,
  creator: PlayerSession,
  settings: GameSettings,
): RoomState {
  if (!isValidSettings(settings)) {
    throw new Error('Timers must be positive whole numbers.')
  }

  const player: Player = {
    ...creator,
    joinIndex: 0,
    connected: true,
  }

  return {
    protocolVersion: 2,
    roomCode: normalizeRoomCode(roomCode),
    creatorId: creator.id,
    revision: 0,
    settings,
    players: {[creator.id]: player},
    joinOrder: [creator.id],
    blockedPlayerIds: [],
    closedAt: null,
    phase: 'lobby',
    round: null,
  }
}

export function joinPlayer(
  state: RoomState,
  session: PlayerSession,
): RoomState {
  if (
    state.phase === 'closed' ||
    state.blockedPlayerIds.includes(session.id)
  ) {
    return state
  }
  const next = copyState(state)
  const existing = next.players[session.id]

  if (existing) {
    const incomingIsNewer =
      session.sessionStartedAt > existing.sessionStartedAt ||
      (session.sessionStartedAt === existing.sessionStartedAt &&
        session.sessionId >= existing.sessionId)
    if (!incomingIsNewer) return state
    existing.name = session.name
    existing.sessionId = session.sessionId
    existing.sessionStartedAt = session.sessionStartedAt
    existing.connected = true
    const assignment = next.round?.assignments[session.id]
    if (assignment) {
      if (assignment.draft) {
        assignment.draft = {
          ...assignment.draft,
          seq: 0,
          sessionId: session.sessionId,
        }
      }
      if (assignment.submission) {
        assignment.submission = {
          ...assignment.submission,
          seq: 0,
          sessionId: session.sessionId,
        }
      }
    }
  } else {
    next.players[session.id] = {
      ...session,
      joinIndex: next.joinOrder.length,
      connected: true,
    }
    next.joinOrder.push(session.id)
  }

  next.revision += 1
  return next
}

export function reclaimCreatorSession(
  state: RoomState,
  session: PlayerSession,
  now: number = Date.now(),
): RoomState {
  if (session.id !== state.creatorId) return state
  const next = copyState(state)
  const creator = next.players[state.creatorId]
  creator.name = session.name
  creator.sessionId = session.sessionId
  creator.sessionStartedAt = Math.max(
    session.sessionStartedAt,
    creator.sessionStartedAt + 1,
  )
  creator.connected = true
  if (next.phase === 'stage' && next.round) {
    next.round.deadline = Math.max(next.round.deadline, now + 20_000)
  }
  next.revision += 1
  return next
}

export function reclaimPlayerSession(
  state: RoomState,
  session: PlayerSession,
): RoomState {
  if (session.id === state.creatorId || !state.players[session.id]) return state
  const next = copyState(state)
  const player = next.players[session.id]
  player.name = session.name
  player.sessionId = session.sessionId
  player.sessionStartedAt += 1
  player.connected = true
  const assignment = next.round?.assignments[session.id]
  if (assignment?.draft) {
    assignment.draft = {
      ...assignment.draft,
      seq: 0,
      sessionId: session.sessionId,
    }
  }
  if (assignment?.submission) {
    assignment.submission = {
      ...assignment.submission,
      seq: 0,
      sessionId: session.sessionId,
    }
  }
  next.revision += 1
  return next
}

export function setPlayerConnected(
  state: RoomState,
  playerId: PlayerId,
  connected: boolean,
): RoomState {
  const player = state.players[playerId]
  if (!player || player.connected === connected) return state

  const next = copyState(state)
  next.players[playerId].connected = connected
  next.revision += 1
  return next
}

export function startRound(
  state: RoomState,
  now: number,
  random: () => number = Math.random,
): RoomState {
  const eligible = state.joinOrder.filter(
    (playerId) => state.players[playerId]?.connected,
  )

  if (eligible.length < MIN_PLAYERS) return state

  const next = copyState(state)
  const order = shuffle(eligible, random)
  const roundNumber = (next.round?.number ?? 0) + 1
  const books = Object.fromEntries(
    order.map((ownerId) => [
      ownerId,
      {ownerId, entries: []} satisfies Book,
    ]),
  )

  next.phase = 'stage'
  next.round = {
    id: createId(),
    number: roundNumber,
    order,
    stageIndex: 0,
    deadline: now + stageDuration(next, 0),
    assignments: makeAssignments(order, 0),
    books,
    reveal: null,
  }
  next.revision += 1
  return next
}

function sameCandidateSession(
  state: RoomState,
  playerId: PlayerId,
  candidate: Candidate,
): boolean {
  return state.players[playerId]?.sessionId === candidate.sessionId
}

function isValidContent(content: Content): boolean {
  if (content.kind === 'text') return content.text.length <= 280
  if (content.strokes.length > 1_000) return false
  let pointCount = 0
  for (const stroke of content.strokes) {
    if (
      stroke.id.length > 128 ||
      !Number.isInteger(stroke.color) ||
      stroke.color < 0 ||
      stroke.color >= 16 ||
      !Number.isInteger(stroke.size) ||
      stroke.size < 0 ||
      stroke.size >= 8 ||
      stroke.points.length > 5_000
    ) {
      return false
    }
    pointCount += stroke.points.length
    if (pointCount > 50_000) return false
    for (const point of stroke.points) {
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !Number.isFinite(point.pressure) ||
        point.x < 0 ||
        point.x > 1 ||
        point.y < 0 ||
        point.y > 1 ||
        point.pressure < 0 ||
        point.pressure > 1
      ) {
        return false
      }
    }
  }
  return true
}

function applyCandidate(
  state: RoomState,
  envelope: IntentEnvelope,
  kind: 'draft' | 'submit',
): RoomState {
  const round = state.round
  const intent = envelope.intent
  if (
    !round ||
    state.phase !== 'stage' ||
    (intent.type !== 'draft' && intent.type !== 'submit') ||
    intent.roundId !== round.id ||
    intent.stageIndex !== round.stageIndex ||
    envelope.sessionId !== intent.candidate.sessionId ||
    !sameCandidateSession(state, envelope.senderId, intent.candidate) ||
    !isValidContent(intent.candidate.content)
  ) {
    return state
  }

  const assignment = round.assignments[envelope.senderId]
  if (
    !assignment ||
    assignment.kind !== intent.candidate.content.kind ||
    kind !== intent.type
  ) {
    return state
  }

  const field = kind === 'draft' ? 'draft' : 'submission'
  const current = assignment[field]
  if (
    current &&
    current.sessionId === intent.candidate.sessionId &&
    current.seq >= intent.candidate.seq
  ) {
    return state
  }

  const next = copyState(state)
  next.round!.assignments[envelope.senderId][field] = intent.candidate
  try {
    if (JSON.stringify(next).length > MAX_ROOM_STATE_CHARS) return state
  } catch {
    return state
  }
  next.revision += 1
  return next
}

function isCreatorControl(state: RoomState, senderId: PlayerId): boolean {
  return senderId === state.creatorId
}

function currentRevealOwner(state: RoomState): PlayerId | null {
  const round = state.round
  if (!round?.reveal) return null
  return round.order[round.reveal.bookIndex] ?? null
}

function canControlReveal(state: RoomState, senderId: PlayerId): boolean {
  return (
    senderId === state.creatorId || senderId === currentRevealOwner(state)
  )
}

export function applyIntent(
  state: RoomState,
  envelope: IntentEnvelope,
  now: number,
  random: () => number = Math.random,
): RoomState {
  const player = state.players[envelope.senderId]
  if (!player || player.sessionId !== envelope.sessionId) return state

  const intent = envelope.intent
  if (intent.type === 'draft' || intent.type === 'submit') {
    return applyCandidate(state, envelope, intent.type)
  }

  if (intent.type === 'close-room') {
    return isCreatorControl(state, envelope.senderId) &&
      intent.roomCode === state.roomCode
      ? closeRoom(state, now)
      : state
  }

  if (intent.type === 'settings') {
    const betweenRounds =
      state.phase === 'lobby' ||
      (state.phase === 'reveal' && Boolean(state.round?.reveal?.complete))
    if (
      !isCreatorControl(state, envelope.senderId) ||
      !betweenRounds ||
      !isValidSettings(intent.settings)
    ) {
      return state
    }
    const next = copyState(state)
    next.settings = intent.settings
    next.revision += 1
    return next
  }

  if (intent.type === 'start-round') {
    const validPhase =
      (state.phase === 'lobby' &&
        intent.expectedPhase === 'lobby' &&
        intent.previousRoundId === null) ||
      (state.phase === 'reveal' &&
        state.round?.reveal?.complete &&
        intent.expectedPhase === 'reveal' &&
        intent.previousRoundId === state.round.id)
    return isCreatorControl(state, envelope.senderId) && validPhase
      ? startRound(state, now, random)
      : state
  }

  if (intent.type === 'force-advance') {
    return isCreatorControl(state, envelope.senderId) &&
      state.phase === 'stage' &&
      state.round?.id === intent.roundId &&
      state.round.stageIndex === intent.stageIndex
      ? advanceStage(state, now)
      : state
  }

  if (intent.type === 'end-round') {
    return isCreatorControl(state, envelope.senderId) &&
      state.phase === 'stage' &&
      state.round?.id === intent.roundId &&
      state.round.stageIndex === intent.stageIndex
      ? endRound(state)
      : state
  }

  if (intent.type === 'kick-player') {
    const validPhase =
      (state.phase === 'lobby' &&
        intent.expectedPhase === 'lobby' &&
        intent.previousRoundId === null) ||
      (state.phase === 'reveal' &&
        state.round?.reveal?.complete &&
        intent.expectedPhase === 'reveal' &&
        intent.previousRoundId === state.round.id)
    return isCreatorControl(state, envelope.senderId) && validPhase
      ? kickPlayer(state, intent.playerId)
      : state
  }

  if (intent.type === 'reset-lobby') {
    if (
      !isCreatorControl(state, envelope.senderId) ||
      !state.round ||
      intent.roundId !== state.round.id
    ) {
      return state
    }
    const next = copyState(state)
    next.phase = 'lobby'
    next.round = null
    next.revision += 1
    return next
  }

  if (
    state.phase !== 'reveal' ||
    !state.round?.reveal ||
    !canControlReveal(state, envelope.senderId)
  ) {
    return state
  }

  if (intent.type === 'reveal-page') {
    const book = getCurrentRevealBook(state)
    if (
      !book ||
      intent.roundId !== state.round.id ||
      intent.bookIndex !== state.round.reveal.bookIndex
    ) {
      return state
    }
    const next = copyState(state)
    next.round!.reveal!.pageIndex = Math.max(
      0,
      Math.min(intent.pageIndex, book.entries.length - 1),
    )
    next.revision += 1
    return next
  }

  if (intent.type === 'reveal-book') {
    if (
      intent.roundId !== state.round.id ||
      intent.bookIndex !== state.round.reveal.bookIndex
    ) {
      return state
    }
    const next = copyState(state)
    const reveal = next.round!.reveal!
    const target = reveal.bookIndex + intent.direction
    if (target < 0) return state
    if (target >= next.round!.order.length) {
      reveal.complete = true
      reveal.pageIndex =
        next.round!.books[next.round!.order[reveal.bookIndex]].entries.length - 1
    } else {
      reveal.bookIndex = target
      reveal.pageIndex = 0
      reveal.complete = false
    }
    next.revision += 1
    return next
  }

  return state
}

function blankContent(kind: StageKind): Content {
  return kind === 'text'
    ? {kind: 'text', text: ''}
    : {kind: 'drawing', strokes: []}
}

function finalizedContent(
  state: RoomState,
  assignment: Assignment,
): Pick<Book['entries'][number], 'content' | 'source'> {
  const candidate = assignment.submission ?? assignment.draft
  const selectedSource = assignment.submission ? 'submission' : 'draft'
  const player = state.players[assignment.playerId]

  if (candidate) {
    if (
      state.round?.stageIndex === 0 &&
      candidate.content.kind === 'text' &&
      !candidate.content.text.trim()
    ) {
      return {
        content: {
          kind: 'text',
          text: `${player.name} did not submit a prompt in time, draw what you think of them`,
        },
        source: 'fallback',
      }
    }
    return {content: candidate.content, source: selectedSource}
  }

  if (state.round?.stageIndex === 0) {
    return {
      content: {
        kind: 'text',
        text: `${player.name} did not submit a prompt in time, draw what you think of them`,
      },
      source: 'fallback',
    }
  }

  return {content: blankContent(assignment.kind), source: 'blank'}
}

function currentStageIsFinalized(state: RoomState): boolean {
  return Boolean(
    state.round &&
      Object.values(state.round.books).some((book) =>
        book.entries.some(
          ({stageIndex}) => stageIndex === state.round!.stageIndex,
        ),
      ),
  )
}

function finalizeCurrentStage(next: RoomState): void {
  const round = next.round!
  const completedStage = round.stageIndex

  for (const playerId of round.order) {
    const assignment = round.assignments[playerId]
    const result = finalizedContent(next, assignment)
    round.books[assignment.bookOwnerId].entries.push({
      stageIndex: completedStage,
      authorId: playerId,
      ...result,
    })
  }
}

function enterReveal(next: RoomState): void {
  next.phase = 'reveal'
  next.round!.deadline = 0
  next.round!.assignments = {}
  next.round!.reveal = {bookIndex: 0, pageIndex: 0, complete: false}
}

export function advanceStage(state: RoomState, now: number): RoomState {
  if (
    state.phase !== 'stage' ||
    !state.round ||
    currentStageIsFinalized(state)
  ) {
    return state
  }

  const next = copyState(state)
  const round = next.round!
  const completedStage = round.stageIndex
  finalizeCurrentStage(next)

  if (completedStage >= round.order.length - 1) {
    enterReveal(next)
  } else {
    round.stageIndex += 1
    round.assignments = makeAssignments(round.order, round.stageIndex)
    round.deadline = now + stageDuration(next, round.stageIndex)
  }

  next.revision += 1
  return next
}

export function endRound(state: RoomState): RoomState {
  if (
    state.phase !== 'stage' ||
    !state.round ||
    currentStageIsFinalized(state)
  ) {
    return state
  }
  const next = copyState(state)
  finalizeCurrentStage(next)
  enterReveal(next)
  next.revision += 1
  return next
}

export function kickPlayer(
  state: RoomState,
  playerId: PlayerId,
): RoomState {
  const betweenRounds =
    state.phase === 'lobby' ||
    (state.phase === 'reveal' && Boolean(state.round?.reveal?.complete))
  if (
    !betweenRounds ||
    !state.players[playerId] ||
    playerId === state.creatorId
  ) {
    return state
  }

  const next = copyState(state)
  next.players[playerId].connected = false
  next.joinOrder = next.joinOrder.filter((id) => id !== playerId)
  if (!next.blockedPlayerIds.includes(playerId)) {
    next.blockedPlayerIds.push(playerId)
  }
  next.revision += 1
  return next
}

export function closeRoom(state: RoomState, now: number): RoomState {
  if (state.phase === 'closed') return state
  const next = copyState(state)
  next.phase = 'closed'
  next.round = null
  next.closedAt = now
  next.revision += 1
  return next
}

export function adoptAuthoritativeSnapshot(
  local: RoomState | null,
  incoming: RoomState,
): RoomState {
  if (!local || local.roomCode !== incoming.roomCode) {
    return structuredClone(incoming)
  }
  if (incoming.creatorId !== local.creatorId) return local
  const incomingCreator = incoming.players[incoming.creatorId]
  const localCreator = local.players[local.creatorId]
  if (
    incomingCreator.sessionStartedAt > localCreator.sessionStartedAt ||
    (incomingCreator.sessionStartedAt === localCreator.sessionStartedAt &&
      incomingCreator.sessionId > localCreator.sessionId)
  ) {
    return structuredClone(incoming)
  }
  if (
    incomingCreator.sessionStartedAt < localCreator.sessionStartedAt ||
    (incomingCreator.sessionStartedAt === localCreator.sessionStartedAt &&
      incomingCreator.sessionId < localCreator.sessionId)
  ) {
    return local
  }
  return incoming.revision >= local.revision
    ? structuredClone(incoming)
    : local
}

export function getAssignment(
  state: RoomState,
  playerId: PlayerId,
): Assignment | null {
  return state.phase === 'stage'
    ? (state.round?.assignments[playerId] ?? null)
    : null
}

export function getAssignmentSource(
  state: RoomState,
  playerId: PlayerId,
): Content | null {
  const assignment = getAssignment(state, playerId)
  const round = state.round
  if (!assignment || !round || round.stageIndex === 0) return null
  return (
    round.books[assignment.bookOwnerId].entries[round.stageIndex - 1]?.content ??
    null
  )
}

export function getCurrentRevealBook(state: RoomState): Book | null {
  const round = state.round
  if (!round?.reveal) return null
  const ownerId = round.order[round.reveal.bookIndex]
  return round.books[ownerId] ?? null
}

export function getSubmissionCount(state: RoomState): number {
  if (state.phase !== 'stage' || !state.round) return 0
  return Object.values(state.round.assignments).filter(
    (assignment) => assignment.submission,
  ).length
}

export function isPendingPlayer(
  state: RoomState,
  playerId: PlayerId,
): boolean {
  return Boolean(
    state.round &&
      state.phase !== 'lobby' &&
      !state.round.order.includes(playerId),
  )
}

export function currentStageLabel(round: RoundState): string {
  if (round.stageIndex === 0) return 'Write a secret prompt'
  return stageKind(round.stageIndex) === 'drawing'
    ? 'Draw what you read'
    : 'Describe what you see'
}

export function intentForCandidate(
  type: 'draft' | 'submit',
  state: RoomState,
  session: PlayerSession,
  content: Content,
  seq: number,
): GameIntent | null {
  if (state.phase !== 'stage' || !state.round) return null
  return {
    type,
    roundId: state.round.id,
    stageIndex: state.round.stageIndex,
    candidate: {
      seq,
      sessionId: session.sessionId,
      content,
    },
  }
}
