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
} from './types'

export const DEFAULT_SETTINGS: GameSettings = {
  promptSeconds: 60,
  drawingSeconds: 120,
}

export const MIN_PLAYERS = 3

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
    Number.isInteger(settings.promptSeconds) &&
    settings.promptSeconds > 0 &&
    Number.isInteger(settings.drawingSeconds) &&
    settings.drawingSeconds > 0
  )
}

export function hydrateRoomState(state: RoomState): RoomState {
  if (
    Array.isArray(state.blockedPlayerIds) &&
    (state.closedAt === null || typeof state.closedAt === 'number')
  ) {
    return state
  }
  return {
    ...state,
    blockedPlayerIds: state.blockedPlayerIds ?? [],
    closedAt: state.closedAt ?? null,
  }
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
    protocolVersion: 1,
    roomCode: normalizeRoomCode(roomCode),
    creatorId: creator.id,
    adminId: creator.id,
    adminPredecessorId: null,
    adminEpoch: 0,
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

function applyCandidate(
  state: RoomState,
  envelope: IntentEnvelope,
  kind: 'draft' | 'submit',
  authoritative: boolean,
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
    !sameCandidateSession(state, envelope.senderId, intent.candidate)
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
  if (authoritative) next.revision += 1
  return next
}

function isAdminControl(state: RoomState, senderId: PlayerId): boolean {
  return senderId === state.adminId || senderId === state.creatorId
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
    return applyCandidate(state, envelope, intent.type, true)
  }

  if (intent.type === 'close-room') {
    return isAdminControl(state, envelope.senderId) &&
      intent.roomCode === state.roomCode
      ? closeRoom(state, now)
      : state
  }

  if (intent.type === 'settings') {
    const betweenRounds =
      state.phase === 'lobby' ||
      (state.phase === 'reveal' && Boolean(state.round?.reveal?.complete))
    if (
      !isAdminControl(state, envelope.senderId) ||
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
    return isAdminControl(state, envelope.senderId) && validPhase
      ? startRound(state, now, random)
      : state
  }

  if (intent.type === 'force-advance') {
    return isAdminControl(state, envelope.senderId) &&
      state.phase === 'stage' &&
      state.round?.id === intent.roundId &&
      state.round.stageIndex === intent.stageIndex
      ? advanceStage(state, now)
      : state
  }

  if (intent.type === 'end-round') {
    return isAdminControl(state, envelope.senderId) &&
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
    return isAdminControl(state, envelope.senderId) && validPhase
      ? kickPlayer(state, intent.playerId)
      : state
  }

  if (intent.type === 'reset-lobby') {
    if (
      !isAdminControl(state, envelope.senderId) ||
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

export function applyBackupIntent(
  state: RoomState,
  envelope: IntentEnvelope,
): RoomState {
  if (envelope.intent.type === 'draft') {
    return applyCandidate(state, envelope, 'draft', false)
  }
  if (envelope.intent.type === 'submit') {
    return applyCandidate(state, envelope, 'submit', false)
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
    playerId === state.adminId ||
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

function mergeCandidate(
  state: RoomState,
  incoming: Candidate | null,
  local: Candidate | null,
  playerId: PlayerId,
): Candidate | null {
  const currentSession = state.players[playerId]?.sessionId
  const valid = [incoming, local].filter(
    (candidate): candidate is Candidate =>
      Boolean(candidate && candidate.sessionId === currentSession),
  )
  return valid.sort((left, right) => right.seq - left.seq)[0] ?? null
}

export function mergeReplica(
  local: RoomState | null,
  incoming: RoomState,
): RoomState {
  if (!local || local.roomCode !== incoming.roomCode) return incoming

  const electionDistance = (state: RoomState): number => {
    const ring =
      state.round && state.phase !== 'lobby'
        ? state.round.order
        : state.joinOrder
    const predecessorIndex = ring.indexOf(state.adminPredecessorId ?? '')
    const adminIndex = ring.indexOf(state.adminId)
    if (predecessorIndex < 0 || adminIndex < 0) return Number.MAX_SAFE_INTEGER
    return (adminIndex - predecessorIndex + ring.length) % ring.length
  }

  const incomingElectionWins =
    electionDistance(incoming) < electionDistance(local) ||
    (electionDistance(incoming) === electionDistance(local) &&
      incoming.adminId < local.adminId)
  const incomingWins =
    incoming.adminEpoch > local.adminEpoch ||
    (incoming.adminEpoch === local.adminEpoch &&
      (incoming.adminId === local.adminId
        ? incoming.revision >= local.revision
        : incomingElectionWins))
  const base = copyState(incomingWins ? incoming : local)
  const other = incomingWins ? local : incoming

  const baseRound = base.round
  const otherRound = other.round
  if (
    base.phase === 'stage' &&
    other.phase === 'stage' &&
    baseRound &&
    otherRound &&
    baseRound.id === otherRound.id &&
    baseRound.stageIndex === otherRound.stageIndex
  ) {
    for (const playerId of baseRound.order) {
      const target = baseRound.assignments[playerId]
      const source = otherRound.assignments[playerId]
      if (!target || !source) continue
      target.draft = mergeCandidate(base, target.draft, source.draft, playerId)
      target.submission = mergeCandidate(
        base,
        target.submission,
        source.submission,
        playerId,
      )
    }
  }

  return base
}

export function electAdmin(
  state: RoomState,
  adminId: PlayerId,
  now: number = Date.now(),
  previousClockOffset = 0,
): RoomState {
  if (!state.players[adminId] || state.adminId === adminId) return state
  const next = copyState(state)
  next.adminPredecessorId = state.adminId
  next.adminId = adminId
  next.adminEpoch += 1
  next.revision += 1
  if (next.phase === 'stage' && next.round) {
    const remaining = Math.max(
      0,
      next.round.deadline - (now + previousClockOffset),
    )
    next.round.deadline = now + remaining
  }
  return next
}

export function nextAdminCandidate(
  state: RoomState,
  connected: ReadonlySet<PlayerId>,
): PlayerId | null {
  const ring =
    state.round && state.phase !== 'lobby'
      ? state.round.order
      : state.joinOrder
  if (!ring.length) return null
  const currentIndex = Math.max(0, ring.indexOf(state.adminId))

  for (let offset = 1; offset <= ring.length; offset += 1) {
    const candidate = ring[(currentIndex + offset) % ring.length]
    if (connected.has(candidate)) return candidate
  }
  return null
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
