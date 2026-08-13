import {describe, expect, it} from 'vitest'

import {ClientEngine} from '../src/clientEngine'
import {
  createId,
  createInitialRoom,
  intentForCandidate,
  playerIdForName,
  reclaimCreatorSession,
} from '../src/game'
import {HostEngine} from '../src/hostEngine'
import type {GameTransport} from '../src/network'
import type {WireMessage} from '../src/protocol'
import type {
  Content,
  PlayerSession,
  RoomState,
  TransportSnapshot,
} from '../src/types'

const ROOM_CODE = 'ABCD1234'

/** Deterministic pseudo-random generator so failures reproduce exactly. */
function makeRng(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0xffffffff
  }
}

interface FaultProfile {
  /** Probability that any single delivery is silently dropped. */
  dropRate: number
  minDelayMs: number
  maxDelayMs: number
  /** Probability that a delivered message arrives twice. */
  duplicateRate: number
}

const RELIABLE: FaultProfile = {
  dropRate: 0,
  minDelayMs: 10,
  maxDelayMs: 40,
  duplicateRate: 0,
}

const FLAKY: FaultProfile = {
  dropRate: 0.3,
  minDelayMs: 20,
  maxDelayMs: 800,
  duplicateRate: 0.1,
}

interface ScheduledDelivery {
  at: number
  toPeerId: string
  fromPeerId: string
  message: WireMessage
}

/**
 * A virtual network hub with a virtual clock. Applies drops, random delays
 * (which naturally reorder messages), duplication, and directional
 * partitions to every delivery between fake transports.
 */
class VirtualNetwork {
  now = 0
  faults: FaultProfile
  private readonly rng: () => number
  private readonly transports = new Map<string, FakeTransport>()
  private readonly blockedLinks = new Set<string>()
  private queue: ScheduledDelivery[] = []
  private readonly pumps: Array<(now: number) => void> = []

  constructor(seed: number, faults: FaultProfile) {
    this.rng = makeRng(seed)
    this.faults = faults
  }

  register(transport: FakeTransport): void {
    this.transports.set(transport.selfPeerId, transport)
  }

  unregister(peerId: string): void {
    this.transports.delete(peerId)
  }

  addPump(pump: (now: number) => void): void {
    this.pumps.push(pump)
  }

  /** Blocks every delivery in both directions between two peers. */
  partition(peerA: string, peerB: string): void {
    this.blockedLinks.add(`${peerA}->${peerB}`)
    this.blockedLinks.add(`${peerB}->${peerA}`)
  }

  heal(peerA: string, peerB: string): void {
    this.blockedLinks.delete(`${peerA}->${peerB}`)
    this.blockedLinks.delete(`${peerB}->${peerA}`)
  }

  send(fromPeerId: string, message: WireMessage, targetPeerId?: string): void {
    const recipients = targetPeerId
      ? [targetPeerId]
      : Array.from(this.transports.keys()).filter((id) => id !== fromPeerId)
    for (const toPeerId of recipients) {
      if (!this.transports.has(toPeerId)) continue
      if (this.blockedLinks.has(`${fromPeerId}->${toPeerId}`)) continue
      if (this.rng() < this.faults.dropRate) continue
      const deliveries = this.rng() < this.faults.duplicateRate ? 2 : 1
      for (let copy = 0; copy < deliveries; copy += 1) {
        const delay =
          this.faults.minDelayMs +
          this.rng() * (this.faults.maxDelayMs - this.faults.minDelayMs)
        this.queue.push({
          at: this.now + delay,
          toPeerId,
          fromPeerId,
          message: structuredClone(message),
        })
      }
    }
  }

  /** Advances virtual time, delivering messages and pumping engines. */
  run(durationMs: number, stepMs = 50): void {
    const end = this.now + durationMs
    while (this.now < end) {
      this.now = Math.min(this.now + stepMs, end)
      const due = this.queue
        .filter((delivery) => delivery.at <= this.now)
        .sort((left, right) => left.at - right.at)
      this.queue = this.queue.filter((delivery) => delivery.at > this.now)
      for (const delivery of due) {
        this.transports
          .get(delivery.toPeerId)
          ?.deliver(delivery.message, delivery.fromPeerId)
      }
      for (const pump of this.pumps) pump(this.now)
    }
  }

  runUntil(
    predicate: () => boolean,
    maxMs: number,
    stepMs = 50,
  ): boolean {
    const end = this.now + maxMs
    while (this.now < end) {
      if (predicate()) return true
      this.run(stepMs, stepMs)
    }
    return predicate()
  }
}

class FakeTransport implements GameTransport {
  readonly kind = 'broadcast' as const
  readonly selfPeerId: string
  private readonly network: VirtualNetwork
  private closed = false
  private readonly listeners = new Set<
    (message: WireMessage, peerId: string) => void
  >()

  constructor(network: VirtualNetwork, peerId: string) {
    this.network = network
    this.selfPeerId = peerId
    network.register(this)
  }

  async send(message: WireMessage, targetPeerId?: string): Promise<void> {
    if (this.closed) return
    this.network.send(this.selfPeerId, message, targetPeerId)
  }

  deliver(message: WireMessage, fromPeerId: string): void {
    for (const listener of this.listeners) listener(message, fromPeerId)
  }

  subscribe(
    listener: (message: WireMessage, peerId: string) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribePeers(): () => void {
    return () => {}
  }

  snapshot(): TransportSnapshot {
    return {kind: this.kind, selfPeerId: this.selfPeerId, peers: []}
  }

  signalingConnected(): boolean {
    return !this.closed
  }

  async close(): Promise<void> {
    this.closed = true
    this.listeners.clear()
    this.network.unregister(this.selfPeerId)
  }
}

function makePlayer(name: string, sessionStartedAt: number): PlayerSession {
  return {
    id: playerIdForName(name),
    name,
    sessionId: `session-${name}-${sessionStartedAt}`,
    sessionStartedAt,
  }
}

interface Harness {
  network: VirtualNetwork
  host: HostEngine
  hostPlayer: PlayerSession
  hostStore: {state: RoomState | null}
  hostTransport: FakeTransport
  clients: ClientEngine[]
  clientPlayers: PlayerSession[]
  clientTransports: FakeTransport[]
}

function createHarness(
  seed: number,
  faults: FaultProfile,
  clientNames: string[],
  clientSkews: number[] = [],
): Harness {
  const network = new VirtualNetwork(seed, faults)
  const hostPlayer = makePlayer('Host', 1_000)
  const hostStore: {state: RoomState | null} = {state: null}
  const hostTransport = new FakeTransport(network, 'peer-host')
  const host = new HostEngine({
    transport: hostTransport,
    roomCode: ROOM_CODE,
    player: hostPlayer,
    initialState: createInitialRoom(ROOM_CODE, hostPlayer, {
      promptSeconds: 30,
      drawingSeconds: 30,
    }),
    onChange: () => {},
    persist: (state) => {
      hostStore.state = structuredClone(state)
    },
    now: () => network.now,
  })
  network.addPump((now) => host.pump(now))

  const clientPlayers = clientNames.map((name) => makePlayer(name, 1_000))
  const clientTransports: FakeTransport[] = []
  const clients = clientPlayers.map((player, index) => {
    const skew = clientSkews[index] ?? 0
    const transport = new FakeTransport(network, `peer-${player.id}`)
    clientTransports.push(transport)
    const client = new ClientEngine({
      transport,
      roomCode: ROOM_CODE,
      player,
      onChange: () => {},
      now: () => network.now + skew,
      random: makeRng(seed * 7 + index),
    })
    network.addPump((now) => client.pump(now + skew))
    return client
  })

  return {
    network,
    host,
    hostPlayer,
    hostStore,
    hostTransport,
    clients,
    clientPlayers,
    clientTransports,
  }
}

function converged(host: HostEngine, client: ClientEngine): boolean {
  return (
    client.state !== null &&
    client.state.revision === host.state.revision &&
    client.state.phase === host.state.phase &&
    client.state.round?.stageIndex === host.state.round?.stageIndex
  )
}

function submitViaClient(
  client: ClientEngine,
  player: PlayerSession,
  content: Content,
  seq: number,
): void {
  const intent = intentForCandidate('submit', client.state!, player, content, seq)
  if (!intent) throw new Error('client is not on a submittable stage')
  client.request({
    id: createId(),
    senderId: player.id,
    sessionId: player.sessionId,
    intent,
  })
}

function submitViaHost(
  host: HostEngine,
  player: PlayerSession,
  content: Content,
  seq: number,
): void {
  const intent = intentForCandidate('submit', host.state, player, content, seq)
  if (!intent) throw new Error('host is not on a submittable stage')
  host.submitLocal({
    id: createId(),
    senderId: player.id,
    sessionId: player.sessionId,
    intent,
  })
}

function contentFor(host: HostEngine, playerId: string): Content {
  const kind = host.state.round!.assignments[playerId]?.kind
  return kind === 'drawing'
    ? {
        kind: 'drawing',
        strokes: [
          {
            id: createId(),
            color: 3,
            size: 2,
            points: [{x: 0.4, y: 0.4, pressure: 0.5}],
          },
        ],
      }
    : {kind: 'text', text: `entry from ${playerId}`}
}

describe('host/client engines under flaky networks', () => {
  it('joins and converges in the lobby despite heavy loss', () => {
    const {network, host, clients} = createHarness(11, FLAKY, [
      'Guest B',
      'Guest C',
    ])

    expect(
      network.runUntil(
        () =>
          host.state.joinOrder.length === 3 &&
          clients.every((client) => converged(host, client)),
        15_000,
      ),
    ).toBe(true)
    expect(host.state.players[playerIdForName('Guest B')]?.connected).toBe(true)
  })

  it('propagates a stage start to all clients quickly on a healthy network', () => {
    const {network, host, hostPlayer, clients} = createHarness(23, RELIABLE, [
      'Guest B',
      'Guest C',
    ])
    network.runUntil(() => host.state.joinOrder.length === 3, 10_000)
    network.runUntil(() => clients.every((c) => converged(host, c)), 10_000)

    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })
    expect(host.state.phase).toBe('stage')

    const started = network.now
    expect(
      network.runUntil(
        () => clients.every((client) => client.state?.phase === 'stage'),
        3_000,
      ),
    ).toBe(true)
    expect(network.now - started).toBeLessThanOrEqual(1_000)
  })

  it('applies a retried submission exactly once and acks it', () => {
    const {network, host, hostPlayer, clients, clientPlayers} = createHarness(
      37,
      {dropRate: 0.45, minDelayMs: 30, maxDelayMs: 900, duplicateRate: 0.25},
      ['Guest B', 'Guest C'],
    )
    network.runUntil(() => host.state.joinOrder.length === 3, 20_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })
    network.runUntil(
      () => clients.every((client) => client.state?.phase === 'stage'),
      20_000,
    )

    const [bee] = clients
    const [beePlayer] = clientPlayers
    submitViaClient(bee, beePlayer, {kind: 'text', text: 'First'}, 1)
    expect(
      network.runUntil(() => bee.pendingRequestCount === 0, 40_000),
    ).toBe(true)
    expect(
      host.state.round!.assignments[beePlayer.id].submission?.content,
    ).toEqual({kind: 'text', text: 'First'})

    // A newer submission replaces the old one exactly once.
    submitViaClient(bee, beePlayer, {kind: 'text', text: 'Second'}, 2)
    expect(
      network.runUntil(() => bee.pendingRequestCount === 0, 40_000),
    ).toBe(true)
    expect(
      host.state.round!.assignments[beePlayer.id].submission,
    ).toMatchObject({seq: 2, content: {kind: 'text', text: 'Second'}})
  })

  it.each([53, 211, 977, 3181, 7919])(
    'completes a full three-stage round under sustained flakiness (seed %i)',
    (seed) => {
    const {network, host, hostPlayer, clients, clientPlayers} = createHarness(
      seed,
      {dropRate: 0.25, minDelayMs: 20, maxDelayMs: 600, duplicateRate: 0.1},
      ['Guest B', 'Guest C'],
    )
    network.runUntil(() => host.state.joinOrder.length === 3, 20_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })

    for (let stage = 0; stage < 3; stage += 1) {
      expect(
        network.runUntil(
          () =>
            host.state.phase === 'stage' &&
            host.state.round?.stageIndex === stage &&
            clients.every(
              (client) =>
                client.state?.phase === 'stage' &&
                client.state.round?.stageIndex === stage,
            ),
          25_000,
        ),
      ).toBe(true)

      submitViaHost(
        host,
        hostPlayer,
        contentFor(host, hostPlayer.id),
        stage + 1,
      )
      clients.forEach((client, index) => {
        const player = clientPlayers[index]
        submitViaClient(
          client,
          player,
          contentFor(host, player.id),
          stage + 1,
        )
      })
    }

    expect(
      network.runUntil(
        () =>
          host.state.phase === 'reveal' &&
          clients.every((client) => converged(host, client)),
        25_000,
      ),
    ).toBe(true)
    for (const book of Object.values(host.state.round!.books)) {
      expect(book.entries).toHaveLength(3)
      expect(
        book.entries.every((entry) => entry.source === 'submission'),
      ).toBe(true)
    }
    },
  )

  it('advances the stage on deadline and catches lagging clients up within two seconds', () => {
    const {network, host, hostPlayer, clients} = createHarness(71, FLAKY, [
      'Guest B',
      'Guest C',
    ])
    network.runUntil(() => host.state.joinOrder.length === 3, 20_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })
    network.runUntil(
      () => clients.every((client) => client.state?.phase === 'stage'),
      20_000,
    )

    const deadline = host.state.round!.deadline
    network.run(Math.max(0, deadline - network.now) + 100)
    expect(host.state.round!.stageIndex).toBe(1)

    const advancedAt = network.now
    expect(
      network.runUntil(
        () => clients.every((client) => client.state?.round?.stageIndex === 1),
        10_000,
      ),
    ).toBe(true)
    expect(network.now - advancedAt).toBeLessThanOrEqual(2_000)
  })

  it('reports client clock offset within jitter bounds under skew', () => {
    const skew = 5_000
    const {network, clients} = createHarness(
      89,
      {dropRate: 0.2, minDelayMs: 15, maxDelayMs: 700, duplicateRate: 0.1},
      ['Guest B'],
      [skew],
    )
    network.run(12_000)
    const [client] = clients
    // The client clock runs five seconds fast; the estimated offset must
    // recover roughly minus that skew despite jittery asymmetric delays.
    expect(client.clockOffsetMs).toBeLessThan(-skew + 400)
    expect(client.clockOffsetMs).toBeGreaterThan(-skew - 400)
  })

  it('shows host offline during a partition, then resyncs within 2.5 seconds', () => {
    const {network, host, hostPlayer, clients} = createHarness(97, RELIABLE, [
      'Guest B',
      'Guest C',
    ])
    network.runUntil(() => host.state.joinOrder.length === 3, 10_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })
    network.runUntil(
      () => clients.every((client) => client.state?.phase === 'stage'),
      10_000,
    )

    const [bee] = clients
    network.partition('peer-host', 'peer-guest b')
    network.run(5_000)
    expect(bee.hostOnline).toBe(false)

    const round = host.state.round!
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {
        type: 'force-advance',
        roundId: round.id,
        stageIndex: round.stageIndex,
      },
    })
    network.run(3_000)
    expect(host.state.round?.stageIndex).toBe(1)
    expect(bee.state?.round?.stageIndex).toBe(0)

    network.heal('peer-host', 'peer-guest b')
    const healedAt = network.now
    expect(
      network.runUntil(
        () => bee.hostOnline && bee.state?.round?.stageIndex === 1,
        10_000,
      ),
    ).toBe(true)
    expect(network.now - healedAt).toBeLessThanOrEqual(2_500)
  })

  it('queues a submission during a partition and delivers it on heal', () => {
    const {network, host, hostPlayer, clients, clientPlayers} = createHarness(
      101,
      RELIABLE,
      ['Guest B', 'Guest C'],
    )
    network.runUntil(() => host.state.joinOrder.length === 3, 10_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })
    network.runUntil(
      () => clients.every((client) => client.state?.phase === 'stage'),
      10_000,
    )

    const [bee] = clients
    const [beePlayer] = clientPlayers
    network.partition('peer-host', 'peer-guest b')
    network.run(2_000)
    submitViaClient(bee, beePlayer, {kind: 'text', text: 'Queued offline'}, 1)
    network.run(4_000)
    expect(
      host.state.round!.assignments[beePlayer.id].submission,
    ).toBeNull()
    expect(bee.pendingRequestCount).toBe(1)

    network.heal('peer-host', 'peer-guest b')
    expect(
      network.runUntil(() => bee.pendingRequestCount === 0, 15_000),
    ).toBe(true)
    expect(
      host.state.round!.assignments[beePlayer.id].submission?.content,
    ).toEqual({kind: 'text', text: 'Queued offline'})
  })

  it('resumes hosting from persisted state and fences the stale host', () => {
    const {network, host, hostPlayer, hostStore, clients} = createHarness(
      113,
      RELIABLE,
      ['Guest B', 'Guest C'],
    )
    network.runUntil(() => host.state.joinOrder.length === 3, 10_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })
    network.runUntil(
      () => clients.every((client) => client.state?.phase === 'stage'),
      10_000,
    )

    // The host tab freezes: it stops pumping and is unreachable, exactly like
    // a closed laptop. Clients notice within the offline window.
    network.partition('peer-host', 'peer-guest b')
    network.partition('peer-host', 'peer-guest c')
    network.run(5_000)
    expect(clients.every((client) => !client.hostOnline)).toBe(true)

    // The same person rejoins with the same name; the app restores the
    // persisted state under a strictly newer incarnation.
    const resumedPlayer = makePlayer('Host', network.now)
    const resumedState = reclaimCreatorSession(
      structuredClone(hostStore.state!),
      resumedPlayer,
      network.now,
    )
    const resumedHost = new HostEngine({
      transport: new FakeTransport(network, 'peer-host-2'),
      roomCode: ROOM_CODE,
      player: resumedPlayer,
      initialState: resumedState,
      onChange: () => {},
      now: () => network.now,
    })
    network.addPump((now) => resumedHost.pump(now))

    expect(
      network.runUntil(
        () =>
          clients.every(
            (client) =>
              client.hostOnline &&
              client.state?.players[client.state.creatorId]?.sessionId ===
                resumedPlayer.sessionId,
          ),
        10_000,
      ),
    ).toBe(true)
    expect(resumedHost.state.phase).toBe('stage')
    expect(resumedHost.state.round!.deadline).toBeGreaterThanOrEqual(
      network.now,
    )

    // The zombie original host wakes up, hears the newer incarnation, and
    // fences itself instead of fighting for the room.
    network.heal('peer-host', 'peer-guest b')
    network.heal('peer-host', 'peer-guest c')
    expect(network.runUntil(() => host.fenced, 10_000)).toBe(true)

    // Clients ignore anything the stale host still manages to send.
    const adoptedSession = () =>
      clients.every(
        (client) =>
          client.state?.players[client.state.creatorId]?.sessionId ===
          resumedPlayer.sessionId,
      )
    network.run(3_000)
    expect(adoptedSession()).toBe(true)
  })

  it('never lets a stale tab steal a seat back from a newer session', () => {
    const {network, host} = createHarness(163, RELIABLE, ['Guest B'])
    network.runUntil(() => host.state.joinOrder.length === 2, 10_000)

    // The same person opens a newer tab: it takes over the seat.
    const newerTab = makePlayer('Guest B', 50_000)
    const newerClient = new ClientEngine({
      transport: new FakeTransport(network, 'peer-guest-b-newer'),
      roomCode: ROOM_CODE,
      player: newerTab,
      onChange: () => {},
      now: () => network.now,
      random: makeRng(999),
    })
    network.addPump((now) => newerClient.pump(now))
    expect(
      network.runUntil(
        () =>
          host.state.players[newerTab.id]?.sessionId === newerTab.sessionId,
        10_000,
      ),
    ).toBe(true)

    // The old tab keeps sending hellos for ten seconds; the seat must not
    // flip back even once.
    for (let step = 0; step < 100; step += 1) {
      network.run(100)
      expect(host.state.players[newerTab.id]?.sessionId).toBe(
        newerTab.sessionId,
      )
    }
  })

  it('recovers after a client network change via transport replacement', () => {
    const {network, host, hostPlayer, clients, clientPlayers, clientTransports} =
      createHarness(139, RELIABLE, ['Guest B', 'Guest C'])
    network.runUntil(() => host.state.joinOrder.length === 3, 10_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })
    network.runUntil(
      () => clients.every((client) => client.state?.phase === 'stage'),
      10_000,
    )

    // Guest B's device switches networks: the old peer link is dead. Work
    // submitted while offline queues locally.
    const [bee] = clients
    const [beePlayer] = clientPlayers
    void clientTransports[0].close()
    submitViaClient(bee, beePlayer, {kind: 'text', text: 'From the new WiFi'}, 1)
    network.run(5_000)
    expect(bee.hostOnline).toBe(false)
    expect(bee.pendingRequestCount).toBe(1)

    // The app rebuilds the transport (hard reconnect): the engine keeps its
    // state and queue, rejoins under a fresh peer link, and drains the queue.
    bee.attachTransport(new FakeTransport(network, 'peer-guest-b-wifi2'))
    expect(
      network.runUntil(
        () => bee.hostOnline && bee.pendingRequestCount === 0,
        10_000,
      ),
    ).toBe(true)
    expect(
      host.state.round!.assignments[beePlayer.id].submission?.content,
    ).toEqual({kind: 'text', text: 'From the new WiFi'})
    expect(network.runUntil(() => converged(host, bee), 5_000)).toBe(true)
  })

  it('remembers the host peer link through silence so the app can inspect it', () => {
    const {network, clients} = createHarness(157, RELIABLE, ['Guest B'])
    const [bee] = clients
    expect(
      network.runUntil(() => bee.lastHostPeerId === 'peer-host', 10_000),
    ).toBe(true)

    // Host silence flips liveness but must not forget which transport link
    // carried host traffic — the fast-reconnect path inspects that link's
    // connection state to decide how long to wait before rebuilding.
    network.partition('peer-host', 'peer-guest b')
    network.run(5_000)
    expect(bee.hostOnline).toBe(false)
    expect(bee.lastHostPeerId).toBe('peer-host')

    // A rebuilt transport starts with no host link until a message arrives.
    network.heal('peer-host', 'peer-guest b')
    bee.attachTransport(new FakeTransport(network, 'peer-guest-b-next'))
    expect(bee.lastHostPeerId).toBeNull()
    expect(
      network.runUntil(() => bee.lastHostPeerId === 'peer-host', 10_000),
    ).toBe(true)
  })

  it('keeps serving after the host device changes networks', () => {
    const {network, host, hostPlayer, hostTransport, clients} = createHarness(
      149,
      RELIABLE,
      ['Guest B', 'Guest C'],
    )
    network.runUntil(() => host.state.joinOrder.length === 3, 10_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })
    network.runUntil(
      () => clients.every((client) => client.state?.phase === 'stage'),
      10_000,
    )

    // The host's device switches networks; every client sees it offline.
    void hostTransport.close()
    network.run(5_000)
    expect(clients.every((client) => !client.hostOnline)).toBe(true)

    // The host app rebuilds its transport; same session, same incarnation.
    host.attachTransport(new FakeTransport(network, 'peer-host-wifi2'))
    expect(
      network.runUntil(
        () => clients.every((client) => client.hostOnline),
        10_000,
      ),
    ).toBe(true)

    // Targeted replies flow over the relearned links: a client request is
    // acknowledged and applied.
    const round = host.state.round!
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {
        type: 'force-advance',
        roundId: round.id,
        stageIndex: round.stageIndex,
      },
    })
    expect(
      network.runUntil(
        () => clients.every((client) => converged(host, client)),
        10_000,
      ),
    ).toBe(true)
  })

  it('keeps every client on the host page across ten flaky stage jumps', () => {
    const {network, host, hostPlayer, clients} = createHarness(
      131,
      {dropRate: 0.35, minDelayMs: 40, maxDelayMs: 1_000, duplicateRate: 0.15},
      ['Guest B', 'Guest C', 'Guest D'],
    )
    network.runUntil(() => host.state.joinOrder.length === 4, 30_000)
    host.submitLocal({
      id: createId(),
      senderId: hostPlayer.id,
      sessionId: hostPlayer.sessionId,
      intent: {type: 'start-round', expectedPhase: 'lobby', previousRoundId: null},
    })

    // Force-advance through the whole round and into reveal paging.
    for (let jump = 0; jump < 10; jump += 1) {
      const current = host.state
      if (current.phase === 'stage' && current.round) {
        host.submitLocal({
          id: createId(),
          senderId: hostPlayer.id,
          sessionId: hostPlayer.sessionId,
          intent: {
            type: 'force-advance',
            roundId: current.round.id,
            stageIndex: current.round.stageIndex,
          },
        })
      } else if (current.phase === 'reveal' && current.round?.reveal) {
        host.submitLocal({
          id: createId(),
          senderId: hostPlayer.id,
          sessionId: hostPlayer.sessionId,
          intent: {
            type: 'reveal-page',
            roundId: current.round.id,
            bookIndex: current.round.reveal.bookIndex,
            pageIndex: current.round.reveal.pageIndex + 1,
          },
        })
      }
      expect(
        network.runUntil(
          () => clients.every((client) => converged(host, client)),
          25_000,
        ),
      ).toBe(true)
    }
  })
})
