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
  ROOM_SILENT_MESSAGE,
  SIGNALING_BLOCKED_MESSAGE,
  createTransport,
  isDeadPeerLink,
  replaceTransport,
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
/**
 * When the transport itself reports the host's peer link as dead, there is
 * no reason to wait out the full silence window — rebuild almost
 * immediately. Every rebuild is a fresh ICE attempt (a new hole-punching
 * roll), so cutting dead time directly raises reconnection odds per minute.
 */
const DEAD_LINK_RECONNECT_MS = 3_000

/**
 * How long to wait before the next hard reconnect. Every rejoin publishes a
 * burst of announce events to the signaling relays, so fruitless retries
 * back off exponentially (12s, 24s, 48s cap) to keep a long host absence
 * from tripping relay rate limits ("you note too much"). Backing off is
 * safe: a returning host is discovered through the *existing* transport
 * without any rebuild — hard reconnects only exist for the rare case where
 * this client's own transport died silently. The dead-link fast path skips
 * the wait because it cannot loop: it requires a live host link that the
 * transport just watched fail, which can only happen again after the host
 * was actually re-contacted (resetting the backoff).
 */
export function hardReconnectWaitMs(
  fruitlessAttempts: number,
  hostLinkDead: boolean,
): number {
  if (hostLinkDead) return DEAD_LINK_RECONNECT_MS
  return HARD_RECONNECT_INTERVAL_MS * 2 ** Math.min(fruitlessAttempts, 2)
}

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
    let reconnectAttempts = 0
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
            current === ROOM_SILENT_MESSAGE ||
            current === SIGNALING_BLOCKED_MESSAGE ||
            current?.startsWith('Another player was found')
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
     * state and queued work across the swap. The swap is strictly
     * sequential (close, then join) and never overlaps itself.
     */
    let reconnectInFlight = false
    const hardReconnect = () => {
      if (disposed || !engineRef.current || reconnectInFlight) return
      reconnectInFlight = true
      const stale = transport
      replaceTransport(stale, newTransport)
        .then((fresh) => {
          reconnectInFlight = false
          if (disposed) {
            void fresh.close()
            return
          }
          transport = fresh
          transportRef.current = fresh
          bindPeers(fresh)
          const engine = engineRef.current
          if (engine?.role === 'host') engine.host.attachTransport(fresh)
          else if (engine?.role === 'client') engine.client.attachTransport(fresh)
        })
        .catch(() => {
          reconnectInFlight = false
        })
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

    // Same-browser host coordination. Host resume data lives in this
    // browser's storage, so a still-running legitimate host can only exist
    // in another tab of this browser. A dedicated channel answers "is
    // anyone hosting this room right now?" instantly and reliably, keeping
    // a duplicate host-name tab from hijacking a healthy room even before
    // any network link forms.
    const lockChannelName = `teleopstrations:v3:hostlock:${config.roomCode}`
    let lockChannel: BroadcastChannel | null = null
    let lockProbeChannel: BroadcastChannel | null = null

    const holdHostLock = () => {
      lockChannel?.close()
      lockChannel = new BroadcastChannel(lockChannelName)
      lockChannel.onmessage = (event: MessageEvent) => {
        const engine = engineRef.current
        if (
          event.data === 'ping' &&
          engine?.role === 'host' &&
          !engine.host.fenced
        ) {
          lockChannel?.postMessage('alive')
        }
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
      holdHostLock()
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
        // This browser hosted the room before. Ask other tabs of this
        // browser and listen briefly for a live host on the network; only
        // if the room is silent everywhere, resume from the saved state.
        const lockProbe = new BroadcastChannel(lockChannelName)
        lockProbeChannel = lockProbe
        const settleAsClient = () => {
          lockProbe.close()
          lockProbeChannel = null
          unsubscribeProbe?.()
          unsubscribeProbe = null
          if (probeTimer !== null) {
            window.clearTimeout(probeTimer)
            probeTimer = null
          }
          startClient()
        }
        lockProbe.onmessage = (event: MessageEvent) => {
          if (event.data === 'alive') settleAsClient()
        }
        lockProbe.postMessage('ping')
        unsubscribeProbe = transport.subscribe((message) => {
          if (
            isValidWireMessage(message, config.roomCode) &&
            isHostMessage(message)
          ) {
            settleAsClient()
          }
        })
        probeTimer = window.setTimeout(() => {
          probeTimer = null
          lockProbe.close()
          lockProbeChannel = null
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
        // example after a WiFi change) and rebuild it from scratch. When
        // the transport confirms the link is dead, skip most of the wait;
        // a merely silent host (closed tab, no live link to inspect) keeps
        // the longer, exponentially backed-off window to avoid rebuild
        // churn and signaling-relay rate limits.
        if (engine.client.state && !engine.client.hostOnline) {
          hostUnreachableSince ??= now
          const hostPeerId = engine.client.lastHostPeerId
          const hostPeer = hostPeerId
            ? transport
                .snapshot()
                .peers.find((peer) => peer.id === hostPeerId)
            : undefined
          const wait = hardReconnectWaitMs(
            reconnectAttempts,
            hostPeer !== undefined &&
              isDeadPeerLink(hostPeer.connectionState),
          )
          if (now - hostUnreachableSince >= wait) {
            hostUnreachableSince = now
            reconnectAttempts += 1
            hardReconnect()
          }
        } else {
          hostUnreachableSince = null
          reconnectAttempts = 0
        }
      }
      if (
        config.mode === 'join' &&
        (config.transportKind ?? 'webrtc') === 'webrtc' &&
        transport.snapshot().peers.length === 0 &&
        now - startedAt >= ISOLATED_PEER_WARNING_MS
      ) {
        // Diagnose why nobody is here: if the discovery relays answer, the
        // room simply is not live; if they do not, this network blocks them.
        const diagnosis = transport.signalingConnected()
          ? ROOM_SILENT_MESSAGE
          : SIGNALING_BLOCKED_MESSAGE
        setError((current) => current ?? diagnosis)
      }
    }, ENGINE_PUMP_INTERVAL_MS)

    return () => {
      disposed = true
      window.removeEventListener('online', onBrowserOnline)
      if (probeTimer !== null) window.clearTimeout(probeTimer)
      if (pumpTimer !== null) window.clearInterval(pumpTimer)
      if (onlineTimer !== null) window.clearTimeout(onlineTimer)
      lockChannel?.close()
      lockProbeChannel?.close()
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
