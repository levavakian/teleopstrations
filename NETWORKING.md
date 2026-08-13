# Networking design

## Scope and threat model

Teleopstrations is a trusted-party game deployed as static files. WebRTC peers
are assumed to run the shipped client. Names are intentionally sufficient to
rejoin, so the protocol does not claim to resist a player who modifies the
client, copies another name, or forges visible room data.

Within that trust model, the protocol is designed to tolerate duplicate,
delayed, reordered, and dropped messages; browser refreshes; temporary
partitions; and a host tab that closes and later rejoins.

## Topology: one host, plain clients

The room creator's tab is the server ("host"). Every other tab is a plain
client that talks only to the host. There is no message relaying, no gossip,
no multihop routing, and no host election of any kind:

- The host owns the canonical `RoomState`, applies every action serially,
  and is the only writer.
- Clients render host-authored state only. Text and drawing editors are
  local until the host confirms them.
- Trystero (Nostr signaling + WebRTC data channels) provides peer discovery
  and pairwise links; the game uses it as a star, ignoring client-to-client
  edges.

## Wire protocol (v3)

Client to host:

- `hello` — presence + the client's current cursor; sent every second (every
  300 ms while catching up). Doubles as the join request and the state
  request: the host replies with a targeted `state` whenever the cursor is
  stale or `wantState` is set.
- `request` — a game action with a unique `requestId`. Retried with backoff
  until acknowledged; the host deduplicates by `requestId` and replays the
  original result for duplicates, so retries are exactly-once.
- `ping` — clock sampling.

Host to client:

- `state` — the full room state, stamped `(incarnation, seq, serverTime)`.
  Broadcast immediately on every meaningful change; draft-only changes are
  batched on a 400 ms timer.
- `tick` — 1 Hz heartbeat with `(incarnation, seq, serverTime, deadline)`.
  Drives host liveness, countdown sync, and staleness detection: a client
  seeing a tick with a newer `seq` than its state requests a fresh state
  immediately, so a lost broadcast is repaired within about one second.
- `ack` — the result of a `request`, targeted at the sender.
- `pong` — clock sampling reply.

## Ordering and idempotence

`incarnation` is the creator session's start stamp and strictly increases
every time the host resumes. `seq` is the state revision within one
incarnation. Clients order all host output by `(incarnation, seq)` and ignore
anything not strictly newer, so duplicated, delayed, or reordered host
messages can never move a client backwards.

Client requests are idempotent at the host through the `requestId` result
cache, and drafts/submissions additionally carry per-candidate sequence
numbers so an older retry can never overwrite newer content.

## Timers

Only the host advances deadlines. Clients estimate the host clock offset from
`ping`/`pong` round trips (the lowest-RTT sample in a sliding window wins,
which bounds the error at half the best round trip); ticks seed the estimate
before the first pong. Countdowns render from the host deadline plus that
offset, so displayed timers agree across clients within roughly one second
even under jitter, and a stage never advances early or late because of a
client's local clock.

## Network changes and reconnection

Robustness to changing networks is layered:

1. **Transport self-repair.** Trystero's Nostr signaling sockets reconnect
   automatically with backoff, rooms keep announcing, and broken WebRTC
   peers are dropped and re-paired. Peer identity is per-tab, so a
   re-paired link continues the same session.
2. **Session-level recovery.** The protocol never assumes a live
   connection: hellos, ticks, request retries, and `(incarnation, seq)`
   ordering make reconnection invisible to game state. Whatever happened
   while unreachable is replayed or fast-forwarded on the next contact.
3. **Hard reconnect fallback.** If a client can still not reach the host
   after 12 s (for example, the device moved to a new network and the old
   WebRTC path is stranded), the app tears down its transport and rejoins
   the signaling room from scratch; engines keep their state and queued
   work across the swap. The browser's `online` event triggers the same
   rebuild immediately after connectivity returns. The host does the same
   on `online`.

The one unavoidable limit: if the *new* network blocks all direct WebRTC
paths, only TURN could help (see below).

## Host resume

The host persists canonical state to `localStorage` on every change. If the
host tab closes, rejoining the same room code with the same name from the
same browser restores the room exactly where it left off:

1. The app sees saved host state whose creator matches the joining name.
2. It listens for ~2.5 s. If a live host answers, it joins as a regular
   client instead (so a second tab cannot steal a healthy room).
3. On silence it resumes hosting under a strictly newer incarnation, with a
   20 s deadline grace so an in-flight stage is not instantly forfeited.

Because resume data lives in this browser's storage, a still-running
legitimate host can only exist in another tab of the same browser. A
dedicated same-browser channel therefore answers "is anyone hosting this
room right now?" instantly during the probe, so a duplicate host-name tab
reliably becomes a spectator instead of hijacking a healthy room — even
before any network link forms. If a stale host tab still slips through, it
fences itself permanently the moment it hears a tick or state with a newer
incarnation, and clients ignore its output by the ordering rule above.

## Multiple tabs and private windows

Several tabs of one browser can each play a different person in the same
room: every tab has its own session and peer identity, and storage keys are
scoped so only the creator's name can resume the room. Opening the same
player name twice hands the seat to the newest tab; the older tab drops to
a "welcome back" screen and can never steal the seat back. Private/incognito
windows behave like a separate browser profile: fine for playing, but host
resume data lives only inside that private session and disappears when it
ends.

While the host is away, clients keep their local editors, queue submissions
(newest per stage wins), show a "host connection interrupted" banner, and
deliver the queue automatically when the host returns. Client refresh or
rejoin by name reclaims the same seat and assignment.

## Payload safeguards

The reducer validates text length, stroke/point counts, coordinates, color
and pen indexes, timer ranges, and total encoded state size before accepting
content; malformed or oversized wire messages are rejected by schema checks
before processing. Pending client queues are bounded and coalesced.

## WebRTC, STUN, and TURN

Three different services are involved in connecting two browsers:

- **Signaling (Nostr relays)** — how peers find each other and exchange
  connection offers. Tiny text messages, so public relays run them for free.
  Already built in.
- **STUN** — tells a device its own public address so peers can attempt a
  direct connection. Free public servers (Google, Cloudflare) are already
  built in via Trystero.
- **TURN** — a relay that carries *all* the game traffic when no direct
  connection can form (strict corporate/carrier NATs). Because it relays
  full bandwidth, no provider offers open credential-free TURN — the last
  well-known one (Open Relay) retired its public static credentials and now
  requires per-account, time-limited API credentials, which a static bundle
  cannot hide.

When nobody is found in a room, the UI now distinguishes the causes: if the
discovery relays answer but no host does, the room simply is not live (the
host can bring it back by rejoining with the same name); if the relays are
unreachable, that network blocks them. Only when a peer is found but the
WebRTC handshake fails is TURN actually the missing piece.

For groups that really play across such networks, the landing page's
"Connection help" panel accepts a pasted `iceServers` JSON array
(`{urls, username, credential}` entries) on each affected device; obtain
credentials from any provider (free tiers exist, for example Metered's).
The list is stored per browser under
`localStorage['teleopstrations:v3:turn-servers']` and passed to WebRTC on
the next join.

Note that "same WiFi" does not guarantee a direct path: routers with
client/AP isolation (common on guest and mesh networks) block
device-to-device traffic and the multicast DNS lookups that browsers use
for LAN candidates, and a VPN on either device moves its traffic elsewhere
entirely. Those setups need TURN just like strict corporate NATs do.

## Testing

- `tests/engines.test.ts` drives the real host/client engines through a
  deterministic virtual network with seeded packet loss (up to 45%), delay
  jitter (up to one second), duplication, reordering, directional
  partitions, and client clock skew. It covers convergence, exactly-once
  submissions, deadline catch-up latency, offline queueing, host resume with
  fencing of the stale host, and clock-offset accuracy, including a
  multi-seed full-round soak.
- `e2e/synchronization.spec.ts` repeats the key scenarios in real browsers
  with a fault-injecting message channel: a full round on a lossy network,
  cross-client countdown agreement, full-block recovery flagged by the host
  monitor, and mid-round host close/resume.
- `e2e/webrtc-live.spec.ts` exercises the production Trystero/WebRTC path.
