import {useCallback, useEffect, useRef, useState} from 'react'

import {createId, intentForCandidate, syncCursorForState} from './game'
import type {ServerMessage} from './serverProtocol'
import type {
  Content,
  ControlIntentRequest,
  GameIntent,
  PeerSyncReport,
  RoomConnection,
  RoomSessionConfig,
  RoomState,
} from './types'

/** Minimum spacing between draft uploads; see sendDraft below. */
export const DRAFT_SEND_INTERVAL_MS = 800
const PING_INTERVAL_MS = 10_000
const CURSOR_INTERVAL_MS = 2_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 10_000
/** A room that is not live is re-checked at a relaxed pace. */
const ROOM_NOT_FOUND_RETRY_MS = 10_000
const MAX_QUEUED_INTENTS = 60
const MAX_CLOCK_SAMPLES = 8

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

function wsUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws`
}

export function useGameRoom(config: RoomSessionConfig): GameRoomApi {
  const [state, setState] = useState<RoomState | null>(null)
  const [status, setStatus] = useState<RoomConnection['status']>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [clockOffsetMs, setClockOffsetMs] = useState(0)
  const [syncReports, setSyncReports] = useState<
    Record<string, PeerSyncReport>
  >({})

  const socketRef = useRef<WebSocket | null>(null)
  const readyRef = useRef(false)
  const stateRef = useRef<RoomState | null>(null)
  const queueRef = useRef<GameIntent[]>([])
  const candidateSeqRef = useRef(0)
  const draftThrottleRef = useRef<{
    lastSentAt: number
    timer: number | null
    latest: Content | null
  }>({lastSentAt: 0, timer: null, latest: null})

  useEffect(() => {
    let disposed = false
    let fatal = false
    let everJoined = false
    let attempts = 0
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let pingTimer: number | null = null
    let lastCursorSentAt = 0
    const pingSentAt = new Map<string, number>()
    const clockSamples: Array<{offset: number; rtt: number}> = []
    let hasPongSample = false

    const send = (message: unknown): void => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message))
      }
    }

    const flushQueue = (): void => {
      const queued = queueRef.current
      queueRef.current = []
      for (const intent of queued) send({type: 'intent', intent})
    }

    const addPongSample = (offset: number, rtt: number): void => {
      hasPongSample = true
      clockSamples.push({offset, rtt})
      if (clockSamples.length > MAX_CLOCK_SAMPLES) clockSamples.shift()
      const best = clockSamples.reduce((left, right) =>
        right.rtt < left.rtt ? right : left,
      )
      setClockOffsetMs(best.offset)
    }

    const adoptState = (incoming: RoomState, serverTime: number): void => {
      stateRef.current = incoming
      setState(incoming)
      if (!hasPongSample) setClockOffsetMs(serverTime - Date.now())
      const nowMs = Date.now()
      if (nowMs - lastCursorSentAt >= CURSOR_INTERVAL_MS) {
        lastCursorSentAt = nowMs
        send({type: 'cursor', cursor: syncCursorForState(incoming)})
      }
    }

    const scheduleReconnect = (delayMs: number): void => {
      if (disposed || fatal || reconnectTimer !== null) return
      setStatus(everJoined ? 'reconnecting' : 'connecting')
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delayMs)
    }

    const handleMessage = (event: MessageEvent): void => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(event.data)) as ServerMessage
      } catch {
        return
      }
      switch (message.type) {
        case 'joined': {
          everJoined = true
          attempts = 0
          readyRef.current = true
          setStatus('connected')
          setError(null)
          adoptState(message.state, message.serverTime)
          flushQueue()
          return
        }
        case 'state':
          adoptState(message.state, message.serverTime)
          return
        case 'tick': {
          if (!hasPongSample) setClockOffsetMs(message.serverTime - Date.now())
          // Report timestamps are in server time; rebase them onto this
          // device's clock so freshness checks work under clock skew.
          const rebased: Record<string, PeerSyncReport> = {}
          for (const [playerId, report] of Object.entries(message.reports)) {
            rebased[playerId] = {
              ...report,
              receivedAt:
                Date.now() - Math.max(0, message.serverTime - report.receivedAt),
            }
          }
          setSyncReports(rebased)
          return
        }
        case 'pong': {
          const sentAt = pingSentAt.get(message.id)
          if (sentAt === undefined) return
          pingSentAt.delete(message.id)
          const nowMs = Date.now()
          const rtt = Math.max(0, nowMs - sentAt)
          addPongSample(message.serverTime + rtt / 2 - nowMs, rtt)
          return
        }
        case 'join-error': {
          setError(message.message)
          if (message.code === 'not-found') {
            // The room may come back (the creator reopening their tab
            // recreates it after a server restart), so keep checking.
            socket?.close()
            scheduleReconnect(ROOM_NOT_FOUND_RETRY_MS)
          } else {
            fatal = true
          }
          return
        }
        case 'superseded': {
          fatal = true
          setError(
            'This name reconnected from another tab or device, which now holds the seat. Close this tab, or rejoin to take the seat back.',
          )
          return
        }
        default:
          return
      }
    }

    const connect = (): void => {
      if (disposed || fatal) return
      readyRef.current = false
      const next = new WebSocket(wsUrl())
      socket = next
      socketRef.current = next
      next.onopen = () => {
        if (disposed) return
        send({
          type: 'join',
          roomCode: config.roomCode,
          player: config.player,
          // Only an explicit "create room" flow may (re)create the room;
          // this also lets the creator's open tab restore the room with the
          // same code and settings after a server restart wiped memory.
          create: config.mode === 'create' && Boolean(config.settings),
          settings: config.settings,
        })
      }
      next.onmessage = handleMessage
      next.onclose = () => {
        if (disposed || fatal || socket !== next) return
        readyRef.current = false
        attempts += 1
        const backoff = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** Math.min(attempts - 1, 3),
        )
        scheduleReconnect(backoff + Math.floor(Math.random() * 300))
      }
      next.onerror = () => {
        next.close()
      }
    }

    connect()

    pingTimer = window.setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return
      const id = createId()
      pingSentAt.set(id, Date.now())
      if (pingSentAt.size > 16) {
        const oldest = pingSentAt.keys().next().value
        if (oldest) pingSentAt.delete(oldest)
      }
      send({type: 'ping', id, clientTime: Date.now()})
    }, PING_INTERVAL_MS)

    const onOnline = () => {
      // A network change often leaves the socket half-dead; rebuild it.
      if (socket && socket.readyState !== WebSocket.OPEN) socket.close()
    }
    window.addEventListener('online', onOnline)

    const throttle = draftThrottleRef.current
    return () => {
      disposed = true
      window.removeEventListener('online', onOnline)
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      if (pingTimer !== null) window.clearInterval(pingTimer)
      if (throttle.timer !== null) window.clearTimeout(throttle.timer)
      throttle.timer = null
      throttle.latest = null
      queueRef.current = []
      readyRef.current = false
      socketRef.current = null
      stateRef.current = null
      socket?.close()
    }
  }, [config])

  const dispatch = useCallback((intent: GameIntent) => {
    const socket = socketRef.current
    if (readyRef.current && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({type: 'intent', intent}))
      return
    }
    // Offline: queue for the reconnect, newest drafts superseding older
    // ones for the same stage so the queue stays small.
    const queue = queueRef.current
    if (intent.type === 'draft' || intent.type === 'submit') {
      queueRef.current = queue.filter(
        (queued) =>
          !(
            queued.type === intent.type &&
            (queued.type === 'draft' || queued.type === 'submit') &&
            queued.roundId === intent.roundId &&
            queued.stageIndex === intent.stageIndex
          ),
      )
    }
    queueRef.current.push(intent)
    if (queueRef.current.length > MAX_QUEUED_INTENTS) queueRef.current.shift()
  }, [])

  const sendCandidate = useCallback(
    (type: 'draft' | 'submit', content: Content) => {
      const current = stateRef.current
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
    [config.player, dispatch],
  )

  /**
   * Drafts fire on every keystroke and every stroke, and each one carries
   * the full cumulative content, so raw sends are the biggest bandwidth
   * cost in the game. Throttle to one send per interval with a trailing
   * flush: the first edit goes out immediately (so the deadline capture on
   * the server is never far behind), and the latest content always follows
   * within the interval.
   */
  const sendDraft = useCallback(
    (content: Content) => {
      const throttle = draftThrottleRef.current
      throttle.latest = content
      const now = Date.now()
      const flush = () => {
        const latest = throttle.latest
        throttle.latest = null
        throttle.lastSentAt = Date.now()
        if (latest) sendCandidate('draft', latest)
      }
      if (now - throttle.lastSentAt >= DRAFT_SEND_INTERVAL_MS) {
        flush()
      } else if (throttle.timer === null) {
        throttle.timer = window.setTimeout(() => {
          throttle.timer = null
          flush()
        }, DRAFT_SEND_INTERVAL_MS - (now - throttle.lastSentAt))
      }
    },
    [sendCandidate],
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
    [dispatch],
  )

  const leave = useCallback(async () => {
    socketRef.current?.close()
    socketRef.current = null
  }, [])

  const creatorConnected =
    state?.players[state.creatorId]?.connected ?? false

  return {
    state,
    connection: {status, error},
    clockOffsetMs,
    creatorConnected,
    syncReports,
    sendDraft,
    submit: (content) => sendCandidate('submit', content),
    sendControl,
    leave,
  }
}
