import {describe, expect, it, vi} from 'vitest'

import {
  ROOM_SILENT_MESSAGE,
  SIGNALING_BLOCKED_MESSAGE,
  describeWebRtcJoinError,
  isDeadPeerLink,
  replaceTransport,
  type GameTransport,
} from '../src/network'
import {
  PROTOCOL_VERSION,
  isValidWireMessage,
} from '../src/protocol'
import {
  adoptSharedTurnServers,
  decodeTurnParam,
  encodeTurnParam,
  hasSharedTurnServers,
  loadTurnServers,
  parseTurnServers,
  saveTurnServersText,
} from '../src/storage'
import {hardReconnectWaitMs} from '../src/useGameRoom'

describe('WebRTC connection guidance', () => {
  it('distinguishes a silent room from a blocked network', () => {
    expect(ROOM_SILENT_MESSAGE).toContain('host may be offline')
    expect(ROOM_SILENT_MESSAGE).toContain('reload the page')
    expect(SIGNALING_BLOCKED_MESSAGE).toContain('discovery relays')
    expect(describeWebRtcJoinError('ICE negotiation failed')).toContain(
      'TURN relay',
    )
    expect(describeWebRtcJoinError('something else')).toContain(
      'something else',
    )
  })
})

describe('dead peer link detection', () => {
  it('flags only states that will not quickly self-heal', () => {
    expect(isDeadPeerLink('failed')).toBe(true)
    expect(isDeadPeerLink('closed')).toBe(true)
    expect(isDeadPeerLink('disconnected')).toBe(true)
    expect(isDeadPeerLink('connected')).toBe(false)
    expect(isDeadPeerLink('connecting')).toBe(false)
    expect(isDeadPeerLink('new')).toBe(false)
  })
})

describe('hard reconnect scheduling', () => {
  it('backs off fruitless retries to spare the signaling relays', () => {
    expect(hardReconnectWaitMs(0, false)).toBe(12_000)
    expect(hardReconnectWaitMs(1, false)).toBe(24_000)
    expect(hardReconnectWaitMs(2, false)).toBe(48_000)
    // Capped: a long host absence must not grow the wait unboundedly.
    expect(hardReconnectWaitMs(9, false)).toBe(48_000)
  })

  it('stays fast when the transport confirmed the host link is dead', () => {
    expect(hardReconnectWaitMs(0, true)).toBe(3_000)
    expect(hardReconnectWaitMs(5, true)).toBe(3_000)
  })
})

describe('transport replacement ordering', () => {
  const makeStale = (close: () => Promise<void>): GameTransport => ({
    kind: 'webrtc',
    selfPeerId: 'stale',
    send: async () => {},
    subscribe: () => () => {},
    subscribePeers: () => () => {},
    snapshot: () => ({kind: 'webrtc', selfPeerId: 'stale', peers: []}),
    signalingConnected: () => false,
    close,
  })

  it('creates the replacement only after the old transport fully closed', async () => {
    let closed = false
    let resolveClose!: () => void
    const stale = makeStale(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = () => {
            closed = true
            resolve()
          }
        }),
    )
    const create = vi.fn(() => {
      // The regression this guards against: joining the signaling room
      // while the previous leave is still pending adopts a doomed room.
      expect(closed).toBe(true)
      return makeStale(async () => {})
    })

    const pending = replaceTransport(stale, create)
    expect(create).not.toHaveBeenCalled()
    resolveClose()
    await pending
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('still creates the replacement when the old close rejects', async () => {
    const stale = makeStale(async () => {
      throw new Error('leave failed: peer channel already dead')
    })
    const create = vi.fn(() => makeStale(async () => {}))
    await replaceTransport(stale, create)
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('optional TURN configuration', () => {
  const MANUAL_KEY = 'teleopstrations:v3:turn-servers'
  const SHARED_KEY = 'teleopstrations:v3:turn-servers:shared'
  const relay = {
    urls: 'turn:relay.example:443',
    username: 'u',
    credential: 'c',
  }

  const clearAll = () => {
    localStorage.removeItem(MANUAL_KEY)
    localStorage.removeItem(SHARED_KEY)
  }

  it('loads only well-formed TURN server entries', () => {
    clearAll()
    expect(loadTurnServers()).toBeNull()

    localStorage.setItem(MANUAL_KEY, 'not json')
    expect(loadTurnServers()).toBeNull()

    localStorage.setItem(MANUAL_KEY, JSON.stringify([relay, {bogus: true}]))
    expect(loadTurnServers()).toEqual([relay])
    clearAll()
  })

  it('accepts the JSON shapes providers hand out', () => {
    // Bare array (Metered), single object, and {iceServers: ...} wrapper
    // around either (Cloudflare's credentials API).
    expect(parseTurnServers(JSON.stringify([relay]))).toEqual([relay])
    expect(parseTurnServers(JSON.stringify(relay))).toEqual([relay])
    expect(parseTurnServers(JSON.stringify({iceServers: [relay]}))).toEqual([
      relay,
    ])
    expect(parseTurnServers(JSON.stringify({iceServers: relay}))).toEqual([
      relay,
    ])
    expect(parseTurnServers(JSON.stringify({iceServers: []}))).toBeNull()
    expect(parseTurnServers('"turn:relay.example"')).toBeNull()
  })

  it('round-trips TURN settings through the invite link parameter', () => {
    const servers = [
      relay,
      {urls: ['turn:a.example:3478', 'turns:a.example:5349'], username: 'ü'},
    ]
    const param = encodeTurnParam(servers)
    // Must survive inside a URL hash without escaping.
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeTurnParam(param)).toEqual(servers)
    expect(decodeTurnParam('!!!not-base64!!!')).toBeNull()
    expect(decodeTurnParam(btoa('"just a string"'))).toBeNull()
  })

  it('merges manual and link-shared servers without duplicates', () => {
    clearAll()
    expect(adoptSharedTurnServers(encodeTurnParam([relay]))).toBe(true)
    expect(hasSharedTurnServers()).toBe(true)
    expect(loadTurnServers()).toEqual([relay])

    const other = {urls: 'turn:other.example:443', username: 'x', credential: 'y'}
    localStorage.setItem(MANUAL_KEY, JSON.stringify([other, relay]))
    expect(loadTurnServers()).toEqual([other, relay])
    clearAll()
  })

  it('treats manual edits as the source of truth over link-shared settings', () => {
    clearAll()
    adoptSharedTurnServers(encodeTurnParam([relay]))

    expect(saveTurnServersText(JSON.stringify([relay]))).toBe('saved')
    expect(hasSharedTurnServers()).toBe(false)

    adoptSharedTurnServers(encodeTurnParam([relay]))
    expect(saveTurnServersText('')).toBe('cleared')
    expect(hasSharedTurnServers()).toBe(false)
    expect(loadTurnServers()).toBeNull()
    expect(saveTurnServersText('{nope')).toBe('invalid')
    clearAll()
  })
})

describe('wire message validation', () => {
  const roomCode = 'ABCD1234'
  const player = {
    id: 'guest b',
    name: 'Guest B',
    sessionId: 'session-1',
    sessionStartedAt: 1_000,
  }

  it('accepts each well-formed message kind', () => {
    expect(
      isValidWireMessage(
        {
          v: PROTOCOL_VERSION,
          roomCode,
          kind: 'hello',
          player,
          cursor: null,
          wantState: true,
        },
        roomCode,
      ),
    ).toBe(true)
    expect(
      isValidWireMessage(
        {
          v: PROTOCOL_VERSION,
          roomCode,
          kind: 'tick',
          incarnation: 5,
          hostSessionId: 'host-session',
          seq: 10,
          serverTime: 123,
          phase: 'stage',
          deadline: 456,
        },
        roomCode,
      ),
    ).toBe(true)
    expect(
      isValidWireMessage(
        {
          v: PROTOCOL_VERSION,
          roomCode,
          kind: 'pong',
          pingId: 'ping-1',
          clientTime: 1,
          serverTime: 2,
        },
        roomCode,
      ),
    ).toBe(true)
  })

  it('rejects wrong versions, rooms, kinds, and malformed payloads', () => {
    expect(isValidWireMessage(null, roomCode)).toBe(false)
    expect(
      isValidWireMessage(
        {v: 2, roomCode, kind: 'ping', pingId: 'x', clientTime: 1},
        roomCode,
      ),
    ).toBe(false)
    expect(
      isValidWireMessage(
        {
          v: PROTOCOL_VERSION,
          roomCode: 'OTHER123',
          kind: 'ping',
          pingId: 'x',
          clientTime: 1,
        },
        roomCode,
      ),
    ).toBe(false)
    expect(
      isValidWireMessage(
        {v: PROTOCOL_VERSION, roomCode, kind: 'gossip'},
        roomCode,
      ),
    ).toBe(false)
    expect(
      isValidWireMessage(
        {
          v: PROTOCOL_VERSION,
          roomCode,
          kind: 'hello',
          player: {id: 42},
          cursor: null,
          wantState: true,
        },
        roomCode,
      ),
    ).toBe(false)
    expect(
      isValidWireMessage(
        {
          v: PROTOCOL_VERSION,
          roomCode,
          kind: 'state',
          incarnation: 1,
          seq: 1,
          serverTime: 1,
          state: {roomCode},
        },
        roomCode,
      ),
    ).toBe(false)
  })
})
