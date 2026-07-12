import {useCallback, useEffect, useMemo, useRef, useState} from 'react'

import {
  adoptAuthoritativeSnapshot,
  advanceStage,
  applyBackupIntent,
  applyIntent,
  createId,
  createInitialRoom,
  electAdmin,
  getSubmissionCount,
  hydrateRoomState,
  intentForCandidate,
  isAdminAuthoritativeSnapshot,
  isSyncCursorAhead,
  joinPlayer,
  nextAdminCandidate,
  setPlayerConnected,
  syncCursorForState,
} from './game'
import {
  TURN_ISOLATION_MESSAGE,
  createTransport,
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
const EMPTY_TRANSPORT: TransportSnapshot = {
  kind: 'webrtc',
  selfPeerId: '',
  peers: [],
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
      cached.protocolVersion !== 1 ||
      cached.roomCode !== config.roomCode
    ) {
      return null
    }
    return joinPlayer(hydrateRoomState(cached), config.player)
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

export interface GameRoomApi {
  state: RoomState | null
  connection: RoomConnection
  clockOffsetMs: number
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
  const [syncReports, setSyncReports] = useState<
    Record<string, PeerSyncReport>
  >({})
  const stateRef = useRef(state)
  const transportRef = useRef<GameTransport | null>(null)
  const sequenceRef = useRef(0)
  const playerLastSeenRef = useRef(new Map<string, number>())
  const peerPlayerRef = useRef(new Map<string, string>())
  const adminLastSeenRef = useRef(Date.now())
  const lastSnapshotSentRef = useRef(0)
  const lastHeartbeatSentRef = useRef(0)
  const lastSyncRequestRef = useRef(0)
  const connectionStartedRef = useRef(Date.now())
  const clockOffsetRef = useRef(0)
  const seenIntentIdsRef = useRef(new Set<string>())
  const seenMessageIdsRef = useRef(new Set<string>())
  const latestAuthoritativeSnapshotRef = useRef<
    Extract<WireMessage, {type: 'snapshot'}> | null
  >(null)

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
      if (next.adminId !== config.player.id) return
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
    [config.player.id, config.player.sessionId, originate],
  )

  const recordSyncReport = useCallback(
    (playerId: string, cursor: SyncCursor, receivedAt: number) => {
      setSyncReports((current) => ({
        ...current,
        [playerId]: {playerId, cursor, receivedAt},
      }))
    },
    [],
  )

  const sendSyncReport = useCallback(
    (current: RoomState) => {
      if (current.adminId === config.player.id) return
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
    [
      config.player.id,
      config.player.sessionId,
      config.roomCode,
      originate,
    ],
  )

  const sendSyncRequest = useCallback(
    (reason: Extract<WireMessage, {type: 'sync-request'}>['reason']) => {
      const current = stateRef.current
      if (current?.adminId === config.player.id) return
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
    [
      config.player.id,
      config.player.sessionId,
      config.roomCode,
      originate,
    ],
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

      if (announceIntent) {
        originate({
          type: 'intent',
          messageId: envelope.id,
          hopsRemaining: GOSSIP_HOP_LIMIT,
          envelope,
        })
      }

      if (current.adminId === config.player.id) {
        if (seenIntentIdsRef.current.has(envelope.id)) return
        seenIntentIdsRef.current.add(envelope.id)
        if (seenIntentIdsRef.current.size > 1_000) {
          const oldest = seenIntentIdsRef.current.values().next().value
          if (oldest) seenIntentIdsRef.current.delete(oldest)
        }
        const now = Date.now()
        let next = applyIntent(current, envelope, now)
        if (
          envelope.intent.type === 'submit' &&
          next.phase === 'stage' &&
          next.round &&
          getSubmissionCount(next) === next.round.order.length
        ) {
          next = advanceStage(next, now)
        }
        if (next !== current) {
          const isCandidate =
            envelope.intent.type === 'draft' ||
            envelope.intent.type === 'submit'
          const stageTransitioned =
            next.phase !== current.phase ||
            next.round?.stageIndex !== current.round?.stageIndex
          publishState(next, !isCandidate || stageTransitioned)
        }
      } else {
        const next = applyBackupIntent(current, envelope)
        if (next !== current) publishState(next, false)
      }
    },
    [config.player.id, originate, publishState],
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
      peerId: string,
      requestSnapshot: boolean,
    ) => {
      peerPlayerRef.current.set(peerId, player.id)
      playerLastSeenRef.current.set(player.id, Date.now())
      const current = stateRef.current
      if (!current || current.adminId !== config.player.id) return
      const known = current.players[player.id]
      if (
        known?.sessionId === player.sessionId &&
        known.connected &&
        known.name === player.name
      ) {
        if (requestSnapshot) sendSnapshot(current, 'join')
        return
      }
      const next = joinPlayer(current, player)
      if (next === current) {
        if (requestSnapshot) sendSnapshot(current, 'join')
      } else {
        publishState(next)
      }
    }

    const unsubscribeMessages = transport.subscribe((message, peerId) => {
      if (disposed || !message || typeof message !== 'object') return
      if (
        typeof message.messageId !== 'string' ||
        typeof message.hopsRemaining !== 'number' ||
        seenMessageIdsRef.current.has(message.messageId)
      ) {
        return
      }
      rememberMessage(message.messageId)

      if (message.type === 'join' || message.type === 'presence') {
        relay(message)
        handleJoin(message.player, peerId, message.type === 'join')
        return
      }

      if (message.type === 'heartbeat') {
        const current = stateRef.current
        if (message.senderId !== message.adminId) return
        relay(message)
        if (
          current &&
          message.adminId === current.adminId &&
          message.senderId === current.adminId &&
          message.sessionId === current.players[current.adminId]?.sessionId &&
          message.adminEpoch >= current.adminEpoch
        ) {
          adminLastSeenRef.current = Date.now()
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

      if (message.type === 'sync-request') {
        if (message.roomCode !== config.roomCode) return
        relay(message)
        const current = stateRef.current
        const player = current?.players[message.senderId]
        if (
          current?.adminId === config.player.id &&
          message.cursor &&
          player?.sessionId === message.sessionId
        ) {
          recordSyncReport(message.senderId, message.cursor, Date.now())
        }
        if (current?.adminId === config.player.id) {
          sendSnapshot(current, 'sync-response')
          return
        }
        const cached = latestAuthoritativeSnapshotRef.current
        if (
          cached &&
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
          current?.adminId === config.player.id &&
          current.players[message.senderId]?.sessionId === message.sessionId
        ) {
          recordSyncReport(message.senderId, message.cursor, Date.now())
        }
        return
      }

      if (message.type === 'snapshot') {
        if (
          message.state.protocolVersion !== 1 ||
          message.state.roomCode !== config.roomCode ||
          !isAdminAuthoritativeSnapshot(
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
          cachedWinner.adminId === incoming.adminId &&
          cachedWinner.adminEpoch === incoming.adminEpoch &&
          cachedWinner.revision === incoming.revision
        ) {
          latestAuthoritativeSnapshotRef.current = message
        }
        const next = adoptAuthoritativeSnapshot(previous, incoming)
        if (
          next.adminId === incoming.adminId &&
          next.adminEpoch === incoming.adminEpoch
        ) {
          adminLastSeenRef.current = Date.now()
          const sample = message.sentAt - Date.now()
          clockOffsetRef.current =
            clockOffsetRef.current * 0.7 + sample * 0.3
          setClockOffsetMs(clockOffsetRef.current)
        }
        publishState(next, false)
        sendSyncReport(next)
        if (
          previous &&
          next.adminEpoch > previous.adminEpoch &&
          next.adminId !== config.player.id &&
          next.phase === 'stage' &&
          next.round
        ) {
          const assignment = next.round.assignments[config.player.id]
          for (const [type, candidate] of [
            ['draft', assignment?.draft],
            ['submit', assignment?.submission],
          ] as const) {
            if (!candidate || candidate.sessionId !== config.player.sessionId) {
              continue
            }
            const envelope: IntentEnvelope = {
              id: createId(),
              senderId: config.player.id,
              sessionId: config.player.sessionId,
              intent: {
                type,
                roundId: next.round.id,
                stageIndex: next.round.stageIndex,
                candidate,
              },
            }
            originate({
              type: 'intent',
              messageId: envelope.id,
              hopsRemaining: GOSSIP_HOP_LIMIT,
              envelope,
            })
          }
        }
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
    if (stateRef.current?.adminId === config.player.id) {
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
      const isAdmin = current.adminId === config.player.id

      if (isAdmin) {
        adminLastSeenRef.current = now
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
            adminId: current.adminId,
            senderId: config.player.id,
            sessionId: config.player.sessionId,
            adminEpoch: current.adminEpoch,
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

      if (now - adminLastSeenRef.current < HEARTBEAT_TIMEOUT_MS) return

      const connected = new Set<string>([config.player.id])
      for (const [playerId, lastSeen] of playerLastSeenRef.current) {
        if (now - lastSeen < HEARTBEAT_TIMEOUT_MS) connected.add(playerId)
      }
      const candidate = nextAdminCandidate(current, connected)
      if (candidate !== config.player.id) return

      const elected = electAdmin(
        current,
        candidate,
        now,
        clockOffsetRef.current,
      )
      clockOffsetRef.current = 0
      setClockOffsetMs(0)
      adminLastSeenRef.current = now
      publishState(elected)
    }, 250)

    return () => {
      disposed = true
      window.clearInterval(presenceTimer)
      window.clearInterval(syncTimer)
      window.clearInterval(coordinatorTimer)
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
    syncReports,
    sendDraft: (content) => sendCandidate('draft', content),
    submit: (content) => sendCandidate('submit', content),
    sendControl,
    leave,
  }
}
