import {describe, expect, it} from 'vitest'

import {
  TURN_ISOLATION_MESSAGE,
  describeWebRtcJoinError,
  isValidWireMessage,
} from '../src/network'

describe('WebRTC connection guidance', () => {
  it('explains the static deployment limitation for TURN-isolated peers', () => {
    expect(TURN_ISOLATION_MESSAGE).toContain('no TURN relay')
    expect(describeWebRtcJoinError('ICE negotiation failed')).toContain(
      'Updates will relay through connected players',
    )
    expect(describeWebRtcJoinError('ICE negotiation failed')).toContain(
      'needs a TURN service or a different network',
    )
  })

  it('rejects malformed, over-hopped, and oversized gossip envelopes', () => {
    expect(isValidWireMessage(null)).toBe(false)
    expect(
      isValidWireMessage({
        type: 'presence',
        messageId: 'message',
        hopsRemaining: 65,
      }),
    ).toBe(false)
    expect(
      isValidWireMessage({
        type: 'presence',
        messageId: 'message',
        hopsRemaining: 1,
        padding: 'x'.repeat(4_000_001),
      }),
    ).toBe(false)
  })
})
