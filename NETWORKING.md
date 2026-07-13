# Networking design

## Scope and threat model

Teleopstrations is a trusted-party game deployed as static files. WebRTC peers
are assumed to run the shipped client. Names are intentionally sufficient to
rejoin, so the protocol does not claim to resist a player who modifies the
client, copies another name, or forges visible room data.

Within that trust model, the protocol is designed to tolerate duplicate,
delayed, reordered, and temporarily undeliverable messages; browser refreshes;
partial WebRTC graphs; and a temporarily unavailable creator.

## Authority invariants

1. The room creator is the only canonical state writer.
2. There is no creator election, acting creator, or automatic authority
   transfer.
3. A local tab is authoritative only when both its player ID and session ID
   match the creator record in canonical state.
4. Non-creator clients never apply intents to canonical state. Their text and
   drawing editors are local until the creator commits the intent.
5. Canonical snapshots are accepted only when attributed to the creator session
   embedded in that snapshot, and only when their creator incarnation and
   revision are not older than the local canonical head.
6. Peer gossip is a transport route. Relaying a creator snapshot or a client
   intent does not grant authority to the relay.

Cryptographic creator signatures would be required outside the trusted-party
model. Name-only identity cannot provide adversarial authentication.

## State machines

### Creator

- **Serving:** validates intents, serially mutates state, publishes snapshots,
  and returns receipts.
- **Recovering:** after a creator refresh, waits for the previous heartbeat to
  expire, gathers cached creator snapshots briefly, selects the highest
  revision, creates a new creator session, and resumes with a deadline grace
  period.
- **Fenced:** a creator tab whose session no longer matches canonical state
  cannot process intents, send heartbeats, or expose creator controls.

### Client

- **Joining:** announces its name/session and requests creator state.
- **Active:** renders creator state, sends intents, and reports its canonical
  cursor.
- **Queueing:** when the creator route is unavailable, keeps local editor state
  and retries a bounded/coalesced intent queue with exponential backoff.
- **Synchronizing:** adopts a creator snapshot and fast-forwards its
  phase/stage/reveal view.
- **Closed/removed:** terminal room states shown by the UI.

## Canonical revisions and cursors

Every canonical mutation increments `revision`. A sync cursor contains:

- creator ID and creator session incarnation;
- revision;
- room phase and round ID/number;
- stage index;
- reveal playbook index, page index, and completion state.

The creator monitor distinguishes:

- **On this page:** same creator session and phase/stage/reveal location;
- **In sync:** on the same page and at the exact creator revision;
- **Stale/disconnected:** no recent report or no current player presence.

## Write protocol

1. A client creates an immutable intent ID.
2. Drafts and repeated submissions for the same stage are coalesced in a
   bounded queue; controls remain distinct.
3. The client sends and retries the intent with exponential backoff and jitter.
4. Peers may relay the unchanged intent through the connected graph.
5. Only the current creator session validates and applies it.
6. The creator stores the result for that intent ID. Duplicate retries receive
   the same accepted/rejected receipt.
7. The client removes the intent only after a creator-attributed receipt.
8. Submissions and stage/control changes trigger immediate creator snapshots;
   drafts are included in periodic snapshots to avoid broadcasting full drawing
   state on every pointer or keystroke update.

## Read and recovery protocol

- Creator mutations push snapshots.
- Clients poll every 15 seconds.
- Creator heartbeats carry a lightweight cursor; a newer cursor triggers an
  immediate sync request.
- Sync requests and responses may traverse bounded, deduplicated gossip.
- Ordinary clients retrieve current state from the creator. Cached old-session
  snapshots are used only to help the same creator recover after a refresh.
- Creator recovery waits out the previous heartbeat, gathers candidate heads,
  selects the highest revision, and fences the previous session by publishing a
  new creator session.
- A reconnecting client adopts the creator snapshot exactly; client-only
  canonical mutations are never merged into it.

## Message and payload safeguards

- Gossip messages have bounded IDs, TTL, count, and encoded size.
- Duplicate message IDs are ignored; intent IDs have durable result semantics
  for the lifetime of the creator tab.
- Text length, stroke count, point count, pen/color indexes, coordinates, and
  pressure are validated by the creator reducer.
- Pending client intents are bounded and draft intents are coalesced.
- Full snapshots remain potentially large; practical room/drawing size is
  constrained by browser memory and WebRTC data-channel capacity even though
  the game has no configured player maximum.

## WebRTC and TURN

Trystero uses Nostr only for peer discovery. It already configures several
public STUN servers, but STUN cannot connect every NAT/firewall pair.

If one direct edge fails while both devices have other peer links, bounded
gossip can still route client intents and creator snapshots through the graph.
If a device cannot establish any peer link, no browser-only protocol can reach
it. That network requires a TURN relay or a different network.

Permanent TURN credentials must not be embedded in a GitHub Pages bundle.
Production TURN support requires an external service that issues short-lived
credentials. Until such a service is configured, the UI reports isolated
devices clearly and keeps retrying.

## Known durability boundary

Creator snapshots are cached in browser storage and replicated to peers, but
there is no backend quorum. A creator recovering on another device cannot prove
that a hidden partition lacks a newer snapshot. The implementation chooses the
highest cached revision it receives after the previous creator heartbeat
expires. Server-grade durable consensus would require backend storage or a
quorum protocol, both outside the static-site constraint.

## Adversarial review outcomes

The post-implementation adversarial review directly changed the design:

- creator privilege now requires an exact creator session match, and ordinary
  joins cannot replace an active creator;
- creator recovery waits for the previous heartbeat to expire, gathers cached
  heads, and resumes from the highest revision instead of the first response;
- duplicate intents return their original result instead of being assumed
  successful;
- retry queues are bounded, drafts/submissions are coalesced, and retries use
  exponential backoff with jitter;
- creator reducer inputs enforce text, stroke, point, coordinate, and packet
  bounds;
- sync reports include player sessions, expire when stale/disconnected, and
  distinguish “same page” from exact revision equality;
- reveal completion is part of the cursor, and old creator sessions are fenced
  from controls, heartbeats, and state publication;
- dead election/failover paths and documentation were removed.

The review also identified two limitations that cannot be honestly solved
inside the current product constraints:

1. Name-only identity and trusted JavaScript do not provide cryptographic
   resistance to a deliberately modified client.
2. A static bundle cannot safely contain permanent TURN credentials or prove
   quorum durability after all creator/browser storage is lost.
