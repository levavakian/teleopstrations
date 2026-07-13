import {useCallback, useEffect, useMemo, useRef, useState} from 'react'

import {
  adoptAuthoritativeSnapshot,
  advanceStage,
  applyIntent,
  createId,
  createInitialRoom,
  getSubmissionCount,
  hydrateRoomState,
  intentForCandidate,
  isCreatorAuthoritativeSnapshot,
  isSyncCursorAhead,
  joinPlayer,
  normalizeName,
  playerIdForName,
  reclaimCreatorSession,
  reclaimPlayerSession,
  setPlayerConnected,
  syncCursorForState,
} from './game'
import {
  TURN_ISOLATION_MESSAGE,
  createTransport,
  isValidWireMessage,
  type GameTransport,
} from './network'
import type {
  Content,
  ControlIntentRequest,
  GameIntent,
  IntentEnvelope,
  PeerSyncReport,
  RoomConnection,
  RoomSessionConfig,
  RoomState,
  SyncCursor,
  TransportSnapshot,
  WireMessage,
} from './types'

const PRESENCE_INTERVAL_MS = 1_000
const HEARTBEAT_INTERVAL_MS = 1_000
const HEARTBEAT_TIMEOUT_MS = 5_000
const SNAPSHOT_INTERVAL_MS = 5_000
const SYNC_INTERVAL_MS = 15_000
const ISOLATED_PEER_WARNING_MS = 15_000
const GOSSIP_HOP_LIMIT = 8
const MAX_SEEN_MESSAGE_IDS = 2_000
const MAX_PENDING_INTENTS = 100
const EMPTY_TRANSPORT: TransportSnapshot = {
  kind: 'webrtc',
  selfPeerId: '',
  peers: [],
}

interface PendingIntent {
  envelope: IntentEnvelope
  attempts: number
  nextRetryAt: number
}

interface IntentResult {
  accepted: boolean
  revision: number
  kind: GameIntent['type']
}

function storageKey(config: RoomSessionConfig): string {
  return `teleopstrations:state:${config.roomCode}:${config.player.id}`
}

function loadCachedState(config: RoomSessionConfig): RoomState | null {
  if (config.mode === 'create') return null
  try {
    const serialized = sessionStorage.getItem(storageKey(config))
    if (!serialized) return null
    const cached = JSON.parse(serialized) as RoomState
    if (
      ![1, 2].includes(Number(cached.protocolVersion)) ||
      cached.roomCode !== config.roomCode
    ) {
      return null
    }
    const hydrated = hydrateRoomState(cached)
    return hydrated
  } catch {
    return null
  }
}

function initialRoom(config: RoomSessionConfig): RoomState | null {
  if (config.mode === 'create' && config.settings) {
    return createInitialRoom(
      config.roomCode,
      config.player,
      config.settings,
    )
  }
  return loadCachedState(config)
}

function isLocalCreatorAuthority(
  state: RoomState,
  config: RoomSessionConfig,
): boolean {
  return (
    state.creatorId === config.player.id &&
    state.players[state.creatorId]?.sessionId === config.player.sessionId
  )
}

function isValidPlayerSession(player: RoomSessionConfig['player']): boolean {
  const name = normalizeName(player.name)
  return (
    name.length > 0 &&
    name.length <= 36 &&
    player.id === playerIdForName(name) &&
    typeof player.sessionId === 'string' &&
    player.sessionId.length <= 128 &&
    Number.isFinite(player.sessionStartedAt)
  )
}

export interface GameRoomApi {
  state: RoomState | null
  connection: RoomConnection
  clockOffsetMs: number
  creatorConnected: boolean
  syncReports: Record<string, PeerSyncReport>
  sendDraft(content: Content): void
  submit(content: Content): void
  sendControl(intent: ControlIntentRequest): void
  leave(): Promise<void>
}

export function useGameRoom(config: RoomSessionConfig): GameRoomApi {
  const [state, setState] = useState<RoomState | null>(() =>
    initialRoom(config),
  )
  const [connection, setConnection] = useState<RoomConnection>({
    status: 'connecting',
    transport: {
      ...EMPTY_TRANSPORT,
      kind: config.transportKind ?? 'webrtc',
    },
    error: null,
  })
  const [clockOffsetMs, setClockOffsetMs] = useState(0)
  const [creatorConnected, setCreatorConnected] = useState(true)
  const [syncReports, setSyncReports] = useState<
    Record<string, PeerSyncReport>
  >({})
  const stateRef = useRef(state)
  const transportRef = useRef<GameTransport | null>(null)
  const sequenceRef = useRef(0)
  const playerLastSeenRef = useRef(new Map<string, number>())
  const creatorLastSeenRef = useRef(Date.now())
  const lastSnapshotSentRef = useRef(0)
  const lastHeartbeatSentRef = useRef(0)
  const lastSyncRequestRef = useRef(0)
  const connectionStartedRef = useRef(Date.now())
  const clockOffsetRef = useRef(0)
  const intentResultsRef = useRef(new Map<string, IntentResult>())
  const pendingIntentsRef = useRef(new Map<string, PendingIntent>())
  const seenMessageIdsRef = useRef(new Set<string>())
  const latestAuthoritativeSnapshotRef = useRef<
    Extract<WireMessage, {type: 'snapshot'}> | null
  >(null)
  const recoveryCandidatesRef = useRef<RoomState[]>([])
  const recoveryTimerRef = useRef<number | null>(null)

  const persist = useCallback(
    (next: RoomState) => {
      try {
        sessionStorage.setItem(storageKey(config), JSON.stringify(next))
      } catch {
        // A very large round can exceed browser storage; peers still replicate it.
      }
    },
    [config],
  )

  const safeSend = useCallback(
    async (message: WireMessage, targetPeerId?: string) => {
      try {
        await transportRef.current?.send(message, targetPeerId)
      } catch (error) {
        setConnection((current) => ({
          ...current,
          error:
            error instanceof Error ? error.message : 'A peer message failed.',
        }))
      }
    },
    [],
  )

  const rememberMessage = useCallback((messageId: string) => {
    const seen = seenMessageIdsRef.current
    seen.add(messageId)
    if (seen.size > MAX_SEEN_MESSAGE_IDS) {
      const oldest = seen.values().next().value
      if (oldest) seen.delete(oldest)
    }
  }, [])

  const originate = useCallback(
    (message: WireMessage) => {
      rememberMessage(message.messageId)
      void safeSend(message)
    },
    [rememberMessage, safeSend],
  )

  const sendSnapshot = useCallback(
    (
      next: RoomState,
      reason: Extract<WireMessage, {type: 'snapshot'}>['reason'],
    ) => {
      if (!isLocalCreatorAuthority(next, config)) return
      const message: Extract<WireMessage, {type: 'snapshot'}> = {
        type: 'snapshot',
        messageId: createId(),
        hopsRemaining: GOSSIP_HOP_LIMIT,
        senderId: config.player.id,
        sessionId: config.player.sessionId,
        state: next,
        reason,
        sentAt: Date.now(),
      }
      latestAuthoritativeSnapshotRef.current = message
      lastSnapshotSentRef.current = message.sentAt
      originate(message)
    },
    [config, originate],
  )

  const recordSyncReport = useCallback(
    (
      playerId: string,
      sessionId: string,
      cursor: SyncCursor,
      receivedAt: number,
    ) => {
      setSyncReports((current) => ({
        ...current,
        [playerId]: {playerId, sessionId, cursor, receivedAt},
      }))
    },
    [],
  )

  const sendSyncReport = useCallback(
    (current: RoomState) => {
      if (isLocalCreatorAuthority(current, config)) return
      originate({
        type: 'sync-report',
        messageId: createId(),
        hopsRemaining: GOSSIP_HOP_LIMIT,
        roomCode: config.roomCode,
        senderId: config.player.id,
        sessionId: config.player.sessionId,
        cursor: syncCursorForState(current),
        sentAt: Date.now(),
      })
    },
    [config, originate],
  )

  const sendSyncRequest = useCallback(
    (reason: Extract<WireMessage, {type: 'sync-request'}>['reason']) => {
      const current = stateRef.current
      if (current && isLocalCreatorAuthority(current, config)) return
      const now = Date.now()
      if (
        reason === 'cursor-ahead' &&
        now - lastSyncRequestRef.current < PRESENCE_INTERVAL_MS
      ) {
        return
      }
      lastSyncRequestRef.current = now
      originate({
        type: 'sync-request',
        messageId: createId(),
        hopsRemaining: GOSSIP_HOP_LIMIT,
        roomCode: config.roomCode,
        senderId: config.player.id,
        sessionId: config.player.sessionId,
        cursor: current ? syncCursorForState(current) : null,
        reason,
        sentAt: now,
      })
    },
    [config, originate],
  )

  const publishState = useCallback(
    (next: RoomState, announce = true) => {
      stateRef.current = next
      setState(next)
      persist(next)
      if (announce) {
        sendSnapshot(next, 'push')
      }
    },
    [persist, sendSnapshot],
  )

  const processIntent = useCallback(
    (envelope: IntentEnvelope, announceIntent: boolean) => {
      const current = stateRef.current
      if (!current) return
      const isCreator = isLocalCreatorAuthority(current, config)

      if (announceIntent && !isCreator) {
        if (
          envelope.intent.type === 'draft' ||
          envelope.intent.type === 'submit'
        ) {
          for (const [id, pending] of pendingIntentsRef.current) {
            const intent = pending.envelope.intent
            if (
              intent.type === envelope.intent.type &&
              (intent.type === 'draft' || intent.type === 'submit') &&
              intent.roundId === envelope.intent.roundId &&
              intent.stageIndex === envelope.intent.stageIndex
            ) {
              pendingIntentsRef.current.delete(id)
            }
          }
        }
        while (pendingIntentsRef.current.size >= MAX_PENDING_INTENTS) {
          const removable = Array.from(pendingIntentsRef.current).find(
            ([, pending]) => pending.envelope.intent.type === 'draft',
          )
          const oldest =
            removable ?? pendingIntentsRef.current.entries().next().value
          if (!oldest) break
          pendingIntentsRef.current.delete(oldest[0])
        }
        pendingIntentsRef.current.set(envelope.id, {
          envelope,
          attempts: 0,
          nextRetryAt: Date.now() + 1_000,
        })
        originate({
          type: 'intent',
          messageId: createId(),
          hopsRemaining: GOSSIP_HOP_LIMIT,
          envelope,
        })
        return
      }

      if (isCreator) {
        const previousResult = intentResultsRef.current.get(envelope.id)
        const intent = envelope.intent
        const assignment =
          (intent.type === 'draft' || intent.type === 'submit') &&
          current.round?.id === intent.roundId &&
          current.round.stageIndex === intent.stageIndex
            ? current.round.assignments[envelope.senderId]
            : null
        const existingCandidate =
          intent.type === 'draft'
            ? assignment?.draft
            : intent.type === 'submit'
              ? assignment?.submission
              : null
        const alreadyApplied = Boolean(
          existingCandidate &&
            (intent.type === 'draft' || intent.type === 'submit') &&
            existingCandidate.sessionId === intent.candidate.sessionId &&
            existingCandidate.seq >= intent.candidate.seq,
        )
        let accepted = previousResult?.accepted ?? alreadyApplied
        let next = current
        if (!previousResult) {
          const now = Date.now()
          next = applyIntent(current, envelope, now)
          accepted = alreadyApplied || next !== current
          if (
            envelope.intent.type === 'submit' &&
            next.phase === 'stage' &&
            next.round &&
            getSubmissionCount(next) === next.round.order.length
          ) {
            next = advanceStage(next, now)
          }
          if (envelope.senderId !== config.player.id) {
            intentResultsRef.current.set(envelope.id, {
              accepted,
              revision: next.revision,
              kind: envelope.intent.type,
            })
            if (intentResultsRef.current.size > 1_000) {
              const removable = Array.from(intentResultsRef.current).find(
                ([, result]) => result.kind === 'draft',
              )
              const oldest =
                removable ?? intentResultsRef.current.entries().next().value
              if (oldest) intentResultsRef.current.delete(oldest[0])
            }
          }
        }
        if (next !== current) {
          const stageTransitioned =
            next.phase !== current.phase ||
            next.round?.stageIndex !== current.round?.stageIndex
          publishState(
            next,
            envelope.intent.type !== 'draft' || stageTransitioned,
          )
        }
        if (envelope.senderId !== config.player.id) {
          originate({
            type: 'intent-ack',
            messageId: createId(),
            hopsRemaining: GOSSIP_HOP_LIMIT,
            senderId: config.player.id,
            sessionId: config.player.sessionId,
            targetPlayerId: envelope.senderId,
            intentId: envelope.id,
            accepted,
            revision: previousResult?.revision ?? next.revision,
            sentAt: Date.now(),
          })
        }
      }
    },
    [config, originate, publishState],
  )

  useEffect(() => {
    let disposed = false
    connectionStartedRef.current = Date.now()
    const transport = createTransport(
      config.transportKind ?? 'webrtc',
      config.roomCode,
      (error) =>
        setConnection((current) => ({...current, error, status: 'reconnecting'})),
    )
    transportRef.current = transport

    const unsubscribePeers = transport.subscribePeers((snapshot) => {
      setConnection((current) => ({
        ...current,
        transport: snapshot,
        error:
          snapshot.peers.length > 0 &&
          (current.error === TURN_ISOLATION_MESSAGE ||
            current.error?.startsWith('A direct WebRTC link failed'))
            ? null
            : current.error,
      }))
    })

    const relay = (message: WireMessage) => {
      if (message.hopsRemaining <= 0) return
      void safeSend({
        ...message,
        hopsRemaining: message.hopsRemaining - 1,
      } as WireMessage)
    }

    const handleJoin = (
      player: RoomSessionConfig['player'],
      requestSnapshot: boolean,
    ) => {
      if (!isValidPlayerSession(player)) return
      const current = stateRef.current
      if (!current || !isLocalCreatorAuthority(current, config)) return
      if (
        player.id === current.creatorId &&
        player.sessionId !== config.player.sessionId
      ) {
        if (requestSnapshot) sendSnapshot(current, 'join')
        return
      }
      const known = current.players[player.id]
      if (known?.sessionId === player.sessionId) {
        playerLastSeenRef.current.set(player.id, Date.now())
        const next = setPlayerConnected(current, player.id, true)
        if (next !== current) publishState(next)
        else if (requestSnapshot) sendSnapshot(current, 'join')
        return
      }
      if (known && !requestSnapshot) return
      const next = known
        ? reclaimPlayerSession(current, player)
        : joinPlayer(current, player)
      if (next === current) {
        if (requestSnapshot) sendSnapshot(current, 'join')
      } else {
        playerLastSeenRef.current.set(player.id, Date.now())
        publishState(next)
      }
    }

    const unsubscribeMessages = transport.subscribe((message) => {
      if (disposed || !isValidWireMessage(message)) return
      if (
        seenMessageIdsRef.current.has(message.messageId)
      ) {
        return
      }
      rememberMessage(message.messageId)

      if (message.type === 'join' || message.type === 'presence') {
        relay(message)
        handleJoin(message.player, message.type === 'join')
        return
      }

      if (message.type === 'heartbeat') {
        const current = stateRef.current
        if (message.senderId !== message.creatorId) return
        relay(message)
        if (!current) {
          creatorLastSeenRef.current = Date.now()
          return
        }
        if (
          message.creatorId === current.creatorId &&
          message.sessionId === current.players[current.creatorId]?.sessionId
        ) {
          creatorLastSeenRef.current = Date.now()
          setCreatorConnected(true)
          const sample = message.sentAt - Date.now()
          clockOffsetRef.current =
            clockOffsetRef.current * 0.7 + sample * 0.3
          setClockOffsetMs(clockOffsetRef.current)
          if (
            isSyncCursorAhead(
              message.cursor,
              syncCursorForState(current),
            )
          ) {
            sendSyncRequest('cursor-ahead')
          }
        }
        return
      }

      if (message.type === 'intent') {
        relay(message)
        processIntent(message.envelope, false)
        return
      }

      if (message.type === 'intent-ack') {
        relay(message)
        const current = stateRef.current
        if (
          current &&
          message.senderId === current.creatorId &&
          message.sessionId === current.players[current.creatorId]?.sessionId &&
          message.targetPlayerId === config.player.id
        ) {
          pendingIntentsRef.current.delete(message.intentId)
          if (!message.accepted) {
            setConnection((currentConnection) => ({
              ...currentConnection,
              error:
                'The creator rejected an outdated or oversized update. Current state was requested.',
            }))
            sendSyncRequest('cursor-ahead')
          }
        }
        return
      }

      if (message.type === 'sync-request') {
        if (message.roomCode !== config.roomCode) return
        relay(message)
        const current = stateRef.current
        const player = current?.players[message.senderId]
        if (
          current &&
          isLocalCreatorAuthority(current, config) &&
          message.cursor &&
          player?.sessionId === message.sessionId
        ) {
          recordSyncReport(
            message.senderId,
            message.sessionId,
            message.cursor,
            Date.now(),
          )
        }
        if (current && isLocalCreatorAuthority(current, config)) {
          if (
            message.cursor &&
            message.cursor.creatorSessionId ===
              current.players[current.creatorId].sessionId &&
            message.cursor.revision === current.revision
          ) {
            return
          }
          sendSnapshot(current, 'sync-response')
          return
        }
        const cached = latestAuthoritativeSnapshotRef.current
        if (
          cached &&
          message.senderId === cached.state.creatorId &&
          (!message.cursor ||
            isSyncCursorAhead(
              syncCursorForState(cached.state),
              message.cursor,
            ))
        ) {
          void safeSend({
            ...cached,
            messageId: createId(),
            hopsRemaining: GOSSIP_HOP_LIMIT,
            reason: 'sync-response',
            sentAt: Date.now(),
          })
        }
        return
      }

      if (message.type === 'sync-report') {
        if (message.roomCode !== config.roomCode) return
        relay(message)
        const current = stateRef.current
        if (
          current &&
          isLocalCreatorAuthority(current, config) &&
          current.players[message.senderId]?.sessionId === message.sessionId
        ) {
          recordSyncReport(
            message.senderId,
            message.sessionId,
            message.cursor,
            Date.now(),
          )
        }
        return
      }

      if (message.type === 'snapshot') {
        if (
          ![1, 2].includes(Number(message.state.protocolVersion)) ||
          message.state.roomCode !== config.roomCode ||
          !isCreatorAuthoritativeSnapshot(
            message.state,
            message.senderId,
            message.sessionId,
          )
        ) {
          return
        }
        relay(message)
        const previous = stateRef.current
        const incoming = hydrateRoomState(message.state)
        const cached = latestAuthoritativeSnapshotRef.current
        const cachedWinner = cached
          ? adoptAuthoritativeSnapshot(cached.state, incoming)
          : incoming
        if (
          cachedWinner.creatorId === incoming.creatorId &&
          cachedWinner.players[cachedWinner.creatorId]?.sessionId ===
            incoming.players[incoming.creatorId]?.sessionId &&
          cachedWinner.revision === incoming.revision
        ) {
          latestAuthoritativeSnapshotRef.current = message
        }
        const next = adoptAuthoritativeSnapshot(previous, incoming)
        if (
          config.player.id === incoming.creatorId &&
          incoming.players[incoming.creatorId]?.sessionId !==
            config.player.sessionId
        ) {
          publishState(next, false)
          recoveryCandidatesRef.current.push(incoming)
          if (
            previous?.creatorId === incoming.creatorId &&
            previous.players[previous.creatorId]?.sessionId !==
              config.player.sessionId
          ) {
            recoveryCandidatesRef.current.push(previous)
          }
          if (recoveryTimerRef.current === null) {
            const remainingHeartbeat = Math.max(
              0,
              HEARTBEAT_TIMEOUT_MS -
                (Date.now() - creatorLastSeenRef.current),
            )
            recoveryTimerRef.current = window.setTimeout(() => {
              recoveryTimerRef.current = null
              if (
                Date.now() - creatorLastSeenRef.current <
                HEARTBEAT_TIMEOUT_MS
              ) {
                recoveryCandidatesRef.current = []
                return
              }
              const best = recoveryCandidatesRef.current.sort((left, right) => {
                const leftCreator = left.players[left.creatorId]
                const rightCreator = right.players[right.creatorId]
                return (
                  rightCreator.sessionStartedAt -
                    leftCreator.sessionStartedAt ||
                  rightCreator.sessionId.localeCompare(leftCreator.sessionId) ||
                  right.revision - left.revision
                )
              })[0]
              recoveryCandidatesRef.current = []
              if (!best) return
              const recovered = reclaimCreatorSession(best, config.player)
              creatorLastSeenRef.current = Date.now()
              setCreatorConnected(true)
              publishState(recovered)
            }, remainingHeartbeat + 1_200)
          }
          return
        }
        if (
          next.creatorId === incoming.creatorId &&
          next.players[next.creatorId]?.sessionId ===
            incoming.players[incoming.creatorId]?.sessionId &&
          next.revision === incoming.revision
        ) {
          creatorLastSeenRef.current = Date.now()
          setCreatorConnected(true)
          const sample = message.sentAt - Date.now()
          clockOffsetRef.current =
            clockOffsetRef.current * 0.7 + sample * 0.3
          setClockOffsetMs(clockOffsetRef.current)
        }
        if (
          previous &&
          previous.players[previous.creatorId]?.sessionId !==
            next.players[next.creatorId]?.sessionId
        ) {
          for (const pending of pendingIntentsRef.current.values()) {
            pending.attempts = 0
            pending.nextRetryAt = 0
          }
        }
        publishState(next, false)
        setConnection((currentConnection) => ({
          ...currentConnection,
          error: currentConnection.error?.startsWith('The creator rejected')
            ? null
            : currentConnection.error,
        }))
        sendSyncReport(next)
      }
    })

    const sendPresence = () => {
      const current = stateRef.current
      const recognized =
        current?.players[config.player.id]?.sessionId ===
        config.player.sessionId
      originate({
        type: recognized ? 'presence' : 'join',
        messageId: createId(),
        hopsRemaining: GOSSIP_HOP_LIMIT,
        player: config.player,
        sentAt: Date.now(),
      })
      playerLastSeenRef.current.set(config.player.id, Date.now())
    }

    sendPresence()
    if (
      stateRef.current &&
      isLocalCreatorAuthority(stateRef.current, config)
    ) {
      sendSnapshot(stateRef.current, 'push')
    } else {
      sendSyncRequest('join')
    }

    const presenceTimer = window.setInterval(sendPresence, PRESENCE_INTERVAL_MS)
    const syncTimer = window.setInterval(() => {
      sendSyncRequest('poll')
      const current = stateRef.current
      if (current) sendSyncReport(current)
    }, SYNC_INTERVAL_MS)
    const retryTimer = window.setInterval(() => {
      const now = Date.now()
      for (const pending of pendingIntentsRef.current.values()) {
        if (pending.nextRetryAt > now) continue
        originate({
          type: 'intent',
          messageId: createId(),
          hopsRemaining: GOSSIP_HOP_LIMIT,
          envelope: pending.envelope,
        })
        pending.attempts += 1
        const backoff = Math.min(15_000, 1_000 * 2 ** pending.attempts)
        pending.nextRetryAt =
          now + backoff + Math.floor(Math.random() * Math.min(500, backoff / 4))
      }
    }, 500)
    const coordinatorTimer = window.setInterval(() => {
      const now = Date.now()
      if (
        config.mode === 'join' &&
        (config.transportKind ?? 'webrtc') === 'webrtc' &&
        transport.snapshot().peers.length === 0 &&
        now - connectionStartedRef.current >= ISOLATED_PEER_WARNING_MS
      ) {
        setConnection((current) =>
          current.error
            ? current
            : {
                ...current,
                error: TURN_ISOLATION_MESSAGE,
                status: 'reconnecting',
              },
        )
      }

      const current = stateRef.current
      if (!current) return
      const isCreator = isLocalCreatorAuthority(current, config)

      if (isCreator) {
        creatorLastSeenRef.current = now
        setCreatorConnected(true)
        if (clockOffsetRef.current !== 0) {
          clockOffsetRef.current = 0
          setClockOffsetMs(0)
        }
        if (
          now - lastHeartbeatSentRef.current >= HEARTBEAT_INTERVAL_MS
        ) {
          lastHeartbeatSentRef.current = now
          originate({
            type: 'heartbeat',
            messageId: createId(),
            hopsRemaining: GOSSIP_HOP_LIMIT,
            creatorId: current.creatorId,
            senderId: config.player.id,
            sessionId: config.player.sessionId,
            revision: current.revision,
            cursor: syncCursorForState(current),
            sentAt: now,
          })
        }

        let presenceState = current
        for (const playerId of current.joinOrder) {
          const connected =
            playerId === config.player.id ||
            now - (playerLastSeenRef.current.get(playerId) ?? 0) <
              HEARTBEAT_TIMEOUT_MS
          presenceState = setPlayerConnected(
            presenceState,
            playerId,
            connected,
          )
        }
        if (presenceState !== current) {
          publishState(presenceState)
          return
        }

        if (
          presenceState.phase === 'stage' &&
          presenceState.round &&
          (getSubmissionCount(presenceState) ===
            presenceState.round.order.length ||
            now >= presenceState.round.deadline)
        ) {
          publishState(advanceStage(presenceState, now))
          return
        }

        if (now - lastSnapshotSentRef.current >= SNAPSHOT_INTERVAL_MS) {
          sendSnapshot(presenceState, 'periodic')
        }
        return
      }

      if (now - creatorLastSeenRef.current >= HEARTBEAT_TIMEOUT_MS) {
        setCreatorConnected(false)
      }
    }, 250)

    return () => {
      disposed = true
      window.clearInterval(presenceTimer)
      window.clearInterval(syncTimer)
      window.clearInterval(retryTimer)
      window.clearInterval(coordinatorTimer)
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
      unsubscribeMessages()
      unsubscribePeers()
      if (transportRef.current === transport) transportRef.current = null
      void transport.close()
    }
  }, [
    config,
    originate,
    processIntent,
    publishState,
    recordSyncReport,
    rememberMessage,
    safeSend,
    sendSnapshot,
    sendSyncReport,
    sendSyncRequest,
  ])

  useEffect(() => {
    stateRef.current = state
    if (state) persist(state)
  }, [persist, state])

  const sendCandidate = useCallback(
    (type: 'draft' | 'submit', content: Content) => {
      const current = stateRef.current
      if (!current) return
      sequenceRef.current += 1
      const intent = intentForCandidate(
        type,
        current,
        config.player,
        content,
        sequenceRef.current,
      )
      if (!intent) return
      processIntent(
        {
          id: createId(),
          senderId: config.player.id,
          sessionId: config.player.sessionId,
          intent,
        },
        true,
      )
    },
    [config.player, processIntent],
  )

  const sendControl = useCallback(
    (request: ControlIntentRequest) => {
      const current = stateRef.current
      if (!current) return
      let intent: GameIntent

      if (request.type === 'settings') {
        intent = request
      } else if (request.type === 'close-room') {
        intent = {type: 'close-room', roomCode: current.roomCode}
      } else if (request.type === 'start-round') {
        if (current.phase !== 'lobby' && current.phase !== 'reveal') return
        intent = {
          type: 'start-round',
          expectedPhase: current.phase,
          previousRoundId: current.round?.id ?? null,
        }
      } else if (request.type === 'force-advance') {
        if (current.phase !== 'stage' || !current.round) return
        intent = {
          type: 'force-advance',
          roundId: current.round.id,
          stageIndex: current.round.stageIndex,
        }
      } else if (request.type === 'end-round') {
        if (current.phase !== 'stage' || !current.round) return
        intent = {
          type: 'end-round',
          roundId: current.round.id,
          stageIndex: current.round.stageIndex,
        }
      } else if (request.type === 'kick-player') {
        if (
          current.phase !== 'lobby' &&
          !(
            current.phase === 'reveal' &&
            current.round?.reveal?.complete
          )
        ) {
          return
        }
        intent = {
          type: 'kick-player',
          playerId: request.playerId,
          expectedPhase:
            current.phase === 'lobby' ? 'lobby' : 'reveal',
          previousRoundId: current.round?.id ?? null,
        }
      } else if (
        request.type === 'reveal-page' ||
        request.type === 'reveal-book'
      ) {
        if (
          current.phase !== 'reveal' ||
          !current.round ||
          !current.round.reveal
        ) {
          return
        }
        intent = {
          ...request,
          roundId: current.round.id,
          bookIndex: current.round.reveal.bookIndex,
        }
      } else {
        if (!current.round) return
        intent = {type: 'reset-lobby', roundId: current.round.id}
      }

      processIntent(
        {
          id: createId(),
          senderId: config.player.id,
          sessionId: config.player.sessionId,
          intent,
        },
        true,
      )
    },
    [config.player.id, config.player.sessionId, processIntent],
  )

  const leave = useCallback(async () => {
    const transport = transportRef.current
    transportRef.current = null
    await transport?.close()
  }, [])

  const effectiveConnection = useMemo<RoomConnection>(() => {
    const recognized =
      state?.players[config.player.id]?.sessionId === config.player.sessionId
    return {
      ...connection,
      status: recognized ? 'connected' : state ? 'reconnecting' : 'connecting',
    }
  }, [config.player.id, config.player.sessionId, connection, state])

  return {
    state,
    connection: effectiveConnection,
    clockOffsetMs,
    creatorConnected,
    syncReports,
    sendDraft: (content) => sendCandidate('draft', content),
    submit: (content) => sendCandidate('submit', content),
    sendControl,
    leave,
  }
}
