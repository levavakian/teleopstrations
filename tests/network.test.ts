import {describe, expect, it, vi} from 'vitest'

import {
  ROOM_SILENT_MESSAGE,
  SIGNALING_BLOCKED_MESSAGE,
  describeWebRtcJoinError,
  replaceTransport,
  type GameTransport,
} from '../src/network'
import {
  PROTOCOL_VERSION,
  isValidWireMessage,
} from '../src/protocol'
import {loadTurnServers} from '../src/storage'

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
  it('loads only well-formed TURN server entries', () => {
    localStorage.removeItem('teleopstrations:v3:turn-servers')
    expect(loadTurnServers()).toBeNull()

    localStorage.setItem('teleopstrations:v3:turn-servers', 'not json')
    expect(loadTurnServers()).toBeNull()

    localStorage.setItem(
      'teleopstrations:v3:turn-servers',
      JSON.stringify([
        {urls: 'turn:relay.example:443', username: 'u', credential: 'c'},
        {bogus: true},
      ]),
    )
    expect(loadTurnServers()).toEqual([
      {urls: 'turn:relay.example:443', username: 'u', credential: 'c'},
    ])
    localStorage.removeItem('teleopstrations:v3:turn-servers')
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
