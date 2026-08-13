import {describe, expect, it} from 'vitest'

import {
  TURN_ISOLATION_MESSAGE,
  describeWebRtcJoinError,
} from '../src/network'
import {
  PROTOCOL_VERSION,
  isValidWireMessage,
} from '../src/protocol'

describe('WebRTC connection guidance', () => {
  it('explains the static deployment limitation for TURN-isolated peers', () => {
    expect(TURN_ISOLATION_MESSAGE).toContain('no TURN relay')
    expect(describeWebRtcJoinError('ICE negotiation failed')).toContain(
      'TURN service or a different network',
    )
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
