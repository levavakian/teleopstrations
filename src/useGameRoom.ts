import {useCallback, useEffect, useMemo, useRef, useState} from 'react'

import {ClientEngine} from './clientEngine'
import {
  createId,
  createInitialRoom,
  intentForCandidate,
  reclaimCreatorSession,
} from './game'
import {HostEngine} from './hostEngine'
import {
  TURN_ISOLATION_MESSAGE,
  createTransport,
  type GameTransport,
} from './network'
import {isHostMessage, isValidWireMessage} from './protocol'
import {loadHostState, saveHostState} from './storage'
import type {
  Content,
  ControlIntentRequest,
  GameIntent,
  IntentEnvelope,
  PeerSyncReport,
  RoomConnection,
  RoomSessionConfig,
  RoomState,
  TransportSnapshot,
} from './types'

const ENGINE_PUMP_INTERVAL_MS = 100
const HOST_PROBE_TIMEOUT_MS = 2_500
const ISOLATED_PEER_WARNING_MS = 15_000
/**
 * If the host stays unreachable this long, the transport itself is suspect
 * (a network change can strand WebRTC links); rejoin the signaling room.
 */
const HARD_RECONNECT_INTERVAL_MS = 12_000

const EMPTY_TRANSPORT: TransportSnapshot = {
  kind: 'webrtc',
  selfPeerId: '',
  peers: [],
}

export interface GameRoomApi {
  state: RoomState | null
  connection: RoomConnection
  clockOffsetMs: number
  creatorConnected: boolean
  /** True when another tab resumed this room's host session. */
  fenced: boolean
  syncReports: Record<string, PeerSyncReport>
  sendDraft(content: Content): void
  submit(content: Content): void
  sendControl(intent: ControlIntentRequest): void
  leave(): Promise<void>
}

type Engine =
  | {role: 'host'; host: HostEngine}
  | {role: 'client'; client: ClientEngine}

export function useGameRoom(config: RoomSessionConfig): GameRoomApi {
  const [state, setState] = useState<RoomState | null>(null)
  const [transportSnapshot, setTransportSnapshot] = useState<TransportSnapshot>({
    ...EMPTY_TRANSPORT,
    kind: config.transportKind ?? 'webrtc',
  })
  const [error, setError] = useState<string | null>(null)
  const [clockOffsetMs, setClockOffsetMs] = useState(0)
  const [creatorConnected, setCreatorConnected] = useState(true)
  const [fenced, setFenced] = useState(false)
  const [syncReports, setSyncReports] = useState<
    Record<string, PeerSyncReport>
  >({})

  const engineRef = useRef<Engine | null>(null)
  const transportRef = useRef<GameTransport | null>(null)
  const candidateSeqRef = useRef(0)

  useEffect(() => {
    let disposed = false
    let probeTimer: number | null = null
    let pumpTimer: number | null = null
    let onlineTimer: number | null = null
    let unsubscribeProbe: (() => void) | null = null
    let unsubscribePeers: (() => void) | null = null
    let hostUnreachableSince: number | null = null
    const startedAt = Date.now()

    const newTransport = () =>
      createTransport(
        config.transportKind ?? 'webrtc',
        config.roomCode,
        (message) => {
          if (!disposed) setError(message)
        },
      )

    const bindPeers = (transport: GameTransport) => {
      unsubscribePeers?.()
      unsubscribePeers = transport.subscribePeers((snapshot) => {
        if (disposed) return
        setTransportSnapshot(snapshot)
        if (snapshot.peers.length > 0) {
          setError((current) =>
            current === TURN_ISOLATION_MESSAGE ||
            current?.startsWith('A direct WebRTC link')
              ? null
              : current,
          )
        }
      })
    }

    let transport = newTransport()
    transportRef.current = transport
    bindPeers(transport)

    /**
     * Drops the current transport and joins the signaling room again. Used
     * when the peer link looks permanently dead (for example after a
     * network change) even though this tab is healthy; engines keep their
     * state and queued work across the swap.
     */
    const hardReconnect = () => {
      if (disposed || !engineRef.current) return
      const stale = transport
      transport = newTransport()
      transportRef.current = transport
      bindPeers(transport)
      const engine = engineRef.current
      if (engine.role === 'host') engine.host.attachTransport(transport)
      else engine.client.attachTransport(transport)
      void stale.close()
    }

    const onBrowserOnline = () => {
      // Give the new network a moment to settle, then rebuild peer links.
      if (disposed || onlineTimer !== null) return
      onlineTimer = window.setTimeout(() => {
        onlineTimer = null
        hardReconnect()
      }, 1_500)
    }
    window.addEventListener('online', onBrowserOnline)

    const syncFromEngine = () => {
      if (disposed) return
      const engine = engineRef.current
      if (!engine) return
      if (engine.role === 'host') {
        setState(engine.host.state)
        setCreatorConnected(!engine.host.fenced)
        setFenced(engine.host.fenced)
        setSyncReports(engine.host.syncReports)
        setClockOffsetMs(0)
      } else {
        setState(engine.client.state)
        setCreatorConnected(engine.client.hostOnline)
        setClockOffsetMs(engine.client.clockOffsetMs)
      }
    }

    const startHost = (initialState: RoomState) => {
      if (disposed) return
      const host = new HostEngine({
        transport,
        roomCode: config.roomCode,
        player: config.player,
        initialState,
        onChange: syncFromEngine,
        persist: saveHostState,
      })
      engineRef.current = {role: 'host', host}
      syncFromEngine()
    }

    const startClient = () => {
      if (disposed) return
      const client = new ClientEngine({
        transport,
        roomCode: config.roomCode,
        player: config.player,
        onChange: syncFromEngine,
      })
      engineRef.current = {role: 'client', client}
      syncFromEngine()
    }

    if (config.mode === 'create' && config.settings) {
      startHost(
        createInitialRoom(config.roomCode, config.player, config.settings),
      )
    } else {
      const stored = loadHostState(config.roomCode)
      const canResume = stored !== null && stored.creatorId === config.player.id
      if (!canResume) {
        startClient()
      } else {
        // This browser hosted the room before. Listen briefly for a live
        // host; if the room is silent, resume hosting from the saved state.
        unsubscribeProbe = transport.subscribe((message) => {
          if (
            isValidWireMessage(message, config.roomCode) &&
            isHostMessage(message)
          ) {
            unsubscribeProbe?.()
            unsubscribeProbe = null
            if (probeTimer !== null) {
              window.clearTimeout(probeTimer)
              probeTimer = null
            }
            startClient()
          }
        })
        probeTimer = window.setTimeout(() => {
          probeTimer = null
          unsubscribeProbe?.()
          unsubscribeProbe = null
          startHost(reclaimCreatorSession(stored, config.player))
        }, HOST_PROBE_TIMEOUT_MS)
      }
    }

    pumpTimer = window.setInterval(() => {
      const engine = engineRef.current
      const now = Date.now()
      if (engine?.role === 'host') {
        engine.host.pump(now)
        syncFromEngine()
      } else if (engine?.role === 'client') {
        engine.client.pump(now)
        syncFromEngine()
        // If the host stays unreachable, assume the peer link died (for
        // example after a WiFi change) and rebuild it from scratch.
        if (engine.client.state && !engine.client.hostOnline) {
          hostUnreachableSince ??= now
          if (now - hostUnreachableSince >= HARD_RECONNECT_INTERVAL_MS) {
            hostUnreachableSince = now
            hardReconnect()
          }
        } else {
          hostUnreachableSince = null
        }
      }
      if (
        config.mode === 'join' &&
        (config.transportKind ?? 'webrtc') === 'webrtc' &&
        transport.snapshot().peers.length === 0 &&
        now - startedAt >= ISOLATED_PEER_WARNING_MS
      ) {
        setError((current) => current ?? TURN_ISOLATION_MESSAGE)
      }
    }, ENGINE_PUMP_INTERVAL_MS)

    return () => {
      disposed = true
      window.removeEventListener('online', onBrowserOnline)
      if (probeTimer !== null) window.clearTimeout(probeTimer)
      if (pumpTimer !== null) window.clearInterval(pumpTimer)
      if (onlineTimer !== null) window.clearTimeout(onlineTimer)
      unsubscribeProbe?.()
      unsubscribePeers?.()
      const engine = engineRef.current
      engineRef.current = null
      if (engine?.role === 'host') engine.host.stop()
      if (engine?.role === 'client') engine.client.stop()
      if (transportRef.current === transport) transportRef.current = null
      void transport.close()
    }
  }, [config])

  const dispatch = useCallback(
    (intent: GameIntent) => {
      const engine = engineRef.current
      if (!engine) return
      const envelope: IntentEnvelope = {
        id: createId(),
        senderId: config.player.id,
        sessionId: config.player.sessionId,
        intent,
      }
      if (engine.role === 'host') {
        engine.host.submitLocal(envelope)
      } else {
        engine.client.request(envelope)
      }
    },
    [config.player.id, config.player.sessionId],
  )

  const currentState = useCallback((): RoomState | null => {
    const engine = engineRef.current
    if (!engine) return null
    return engine.role === 'host' ? engine.host.state : engine.client.state
  }, [])

  const sendCandidate = useCallback(
    (type: 'draft' | 'submit', content: Content) => {
      const current = currentState()
      if (!current) return
      candidateSeqRef.current += 1
      const intent = intentForCandidate(
        type,
        current,
        config.player,
        content,
        candidateSeqRef.current,
      )
      if (intent) dispatch(intent)
    },
    [config.player, currentState, dispatch],
  )

  const sendControl = useCallback(
    (request: ControlIntentRequest) => {
      const current = currentState()
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
          !(current.phase === 'reveal' && current.round?.reveal?.complete)
        ) {
          return
        }
        intent = {
          type: 'kick-player',
          playerId: request.playerId,
          expectedPhase: current.phase === 'lobby' ? 'lobby' : 'reveal',
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

      dispatch(intent)
    },
    [currentState, dispatch],
  )

  const leave = useCallback(async () => {
    const engine = engineRef.current
    engineRef.current = null
    if (engine?.role === 'host') engine.host.stop()
    if (engine?.role === 'client') engine.client.stop()
    const transport = transportRef.current
    transportRef.current = null
    await transport?.close()
  }, [])

  const connection = useMemo<RoomConnection>(() => {
    const recognized =
      state?.players[config.player.id]?.sessionId === config.player.sessionId
    return {
      status: recognized ? 'connected' : state ? 'reconnecting' : 'connecting',
      transport: transportSnapshot,
      error,
    }
  }, [config.player.id, config.player.sessionId, error, state, transportSnapshot])

  return {
    state,
    connection,
    clockOffsetMs,
    creatorConnected,
    fenced,
    syncReports,
    sendDraft: (content) => sendCandidate('draft', content),
    submit: (content) => sendCandidate('submit', content),
    sendControl,
    leave,
  }
}
