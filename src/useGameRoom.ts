import {useCallback, useEffect, useMemo, useRef, useState} from 'react'

import {
  advanceStage,
  applyBackupIntent,
  applyIntent,
  createId,
  createInitialRoom,
  electAdmin,
  intentForCandidate,
  joinPlayer,
  mergeReplica,
  nextAdminCandidate,
  setPlayerConnected,
} from './game'
import {createTransport, type GameTransport} from './network'
import type {
  Content,
  GameIntent,
  IntentEnvelope,
  RoomConnection,
  RoomSessionConfig,
  RoomState,
  TransportSnapshot,
  WireMessage,
} from './types'

const PRESENCE_INTERVAL_MS = 1_000
const HEARTBEAT_TIMEOUT_MS = 5_000
const SNAPSHOT_INTERVAL_MS = 2_000
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
    return joinPlayer(cached, config.player)
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
  sendDraft(content: Content): void
  submit(content: Content): void
  sendControl(intent: Exclude<GameIntent, {type: 'draft' | 'submit'}>): void
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
  const stateRef = useRef(state)
  const transportRef = useRef<GameTransport | null>(null)
  const sequenceRef = useRef(0)
  const playerLastSeenRef = useRef(new Map<string, number>())
  const peerPlayerRef = useRef(new Map<string, string>())
  const adminLastSeenRef = useRef(Date.now())
  const lastSnapshotSentRef = useRef(0)

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

  const publishState = useCallback(
    (next: RoomState, announce = true) => {
      stateRef.current = next
      setState(next)
      persist(next)
      if (announce) {
        lastSnapshotSentRef.current = Date.now()
        void safeSend({type: 'snapshot', state: next, sentAt: Date.now()})
      }
    },
    [persist, safeSend],
  )

  const processIntent = useCallback(
    (envelope: IntentEnvelope, announceIntent: boolean) => {
      const current = stateRef.current
      if (!current) return

      if (announceIntent) {
        void safeSend({type: 'intent', envelope})
      }

      if (current.adminId === config.player.id) {
        const next = applyIntent(current, envelope, Date.now())
        if (next !== current) publishState(next)
      } else {
        const next = applyBackupIntent(current, envelope)
        if (next !== current) publishState(next, false)
      }
    },
    [config.player.id, publishState, safeSend],
  )

  useEffect(() => {
    let disposed = false
    const transport = createTransport(
      config.transportKind ?? 'webrtc',
      config.roomCode,
      (error) =>
        setConnection((current) => ({...current, error, status: 'reconnecting'})),
    )
    transportRef.current = transport

    const unsubscribePeers = transport.subscribePeers((snapshot) => {
      setConnection((current) => ({...current, transport: snapshot}))
    })

    const handleJoin = (
      player: RoomSessionConfig['player'],
      peerId: string,
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
        void safeSend(
          {type: 'snapshot', state: current, sentAt: Date.now()},
          peerId,
        )
        return
      }
      publishState(joinPlayer(current, player))
    }

    const unsubscribeMessages = transport.subscribe((message, peerId) => {
      if (disposed || !message || typeof message !== 'object') return

      if (message.type === 'join' || message.type === 'presence') {
        handleJoin(message.player, peerId)
        return
      }

      if (message.type === 'heartbeat') {
        const current = stateRef.current
        if (
          current &&
          message.adminId === current.adminId &&
          message.adminEpoch >= current.adminEpoch
        ) {
          adminLastSeenRef.current = Date.now()
        }
        return
      }

      if (message.type === 'intent') {
        processIntent(message.envelope, false)
        return
      }

      if (
        message.type === 'snapshot' &&
        message.state.protocolVersion === 1 &&
        message.state.roomCode === config.roomCode
      ) {
        const next = mergeReplica(stateRef.current, message.state)
        if (
          next.adminId === message.state.adminId &&
          next.adminEpoch === message.state.adminEpoch
        ) {
          adminLastSeenRef.current = Date.now()
        }
        publishState(next, false)
      }
    })

    const sendPresence = () => {
      const current = stateRef.current
      const recognized =
        current?.players[config.player.id]?.sessionId ===
        config.player.sessionId
      void safeSend({
        type: recognized ? 'presence' : 'join',
        player: config.player,
        sentAt: Date.now(),
      })
      playerLastSeenRef.current.set(config.player.id, Date.now())
    }

    sendPresence()
    if (stateRef.current?.adminId === config.player.id) {
      publishState(stateRef.current)
    }

    const presenceTimer = window.setInterval(sendPresence, PRESENCE_INTERVAL_MS)
    const coordinatorTimer = window.setInterval(() => {
      const current = stateRef.current
      if (!current) return
      const now = Date.now()
      const isAdmin = current.adminId === config.player.id

      if (isAdmin) {
        adminLastSeenRef.current = now
        void safeSend({
          type: 'heartbeat',
          adminId: current.adminId,
          adminEpoch: current.adminEpoch,
          revision: current.revision,
          sentAt: now,
        })

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
          now >= presenceState.round.deadline
        ) {
          publishState(advanceStage(presenceState, now))
          return
        }

        if (now - lastSnapshotSentRef.current >= SNAPSHOT_INTERVAL_MS) {
          publishState(presenceState)
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

      const elected = electAdmin(current, candidate)
      adminLastSeenRef.current = now
      publishState(elected)
    }, 250)

    return () => {
      disposed = true
      window.clearInterval(presenceTimer)
      window.clearInterval(coordinatorTimer)
      unsubscribeMessages()
      unsubscribePeers()
      if (transportRef.current === transport) transportRef.current = null
      void transport.close()
    }
  }, [
    config,
    processIntent,
    publishState,
    safeSend,
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
    (intent: Exclude<GameIntent, {type: 'draft' | 'submit'}>) => {
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
    sendDraft: (content) => sendCandidate('draft', content),
    submit: (content) => sendCandidate('submit', content),
    sendControl,
    leave,
  }
}
