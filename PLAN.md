# Teleopstrations implementation plan

## Goal

Build a static, browser-based multiplayer drawing-and-guessing game that can be
deployed to GitHub Pages. A room creator configures the timers, players join
with a room code and display name, and every frozen player roster completes one
Telestrations chain concurrently without a dedicated application server.

## Definition of done

- A creator can create a room, choose prompt and drawing deadlines, and share a
  room code or link.
- Multiple players can join, see connection/readiness state, and start a round.
- The round freezes player order; later arrivals wait until the next round.
- Every frozen player starts one book, then receives the previous player's book
  on each alternating drawing/description stage.
- A stage advances when every active player submits or when its deadline (or an
  admin action) ends it.
- At a prompt deadline, the latest non-empty draft is accepted; an empty
  original prompt receives the specified player-name fallback. At drawing
  deadlines, the latest synchronized canvas is accepted.
- Players see the number and names/statuses of submitted, waiting, disconnected,
  and pending players without seeing hidden book content.
- A disconnected player can reclaim their frozen seat and resume the current
  stage.
- The completed books can be revealed, and the creator can start another round
  that incorporates pending players.
- A GitHub Actions workflow builds and deploys the static site to GitHub Pages.
- Automated and manual tests demonstrate a complete multiplayer round,
  deadline behavior, reconnection, pending players, and creator controls.

## Proposed stack

- **Application:** React, TypeScript, and Vite.
- **Peer networking:** Trystero over its decentralized/public signaling
  strategy, with WebRTC data channels carrying game messages. This keeps the
  deployed application static; the signaling relay helps peers discover each
  other but is not an application/game-state server.
- **State management:** A pure, typed game-state reducer plus a transport
  adapter. The room coordinator validates actions and publishes versioned state
  snapshots; peers acknowledge updates and can request a fresh snapshot.
- **Drawing:** Pointer-event HTML canvas with normalized coordinates, vector
  strokes, 16 fixed colors, 8 fixed widths, undo, and clear-with-confirmation.
  Vector data keeps drafts compact and allows crisp redraws after resizing.
- **Persistence:** Browser storage for the local player identity, room
  membership, latest room snapshot, and in-progress local draft.
- **Testing:** Vitest and Testing Library for logic/components; Playwright for
  deterministic multi-client browser tests and a live WebRTC smoke test.
- **Deployment:** GitHub's official Pages artifact and deployment actions,
  using Vite's repository-aware base path.

The network layer will be an interface rather than being coupled directly to
Trystero. Production will use Trystero; tests can use a deterministic in-memory
transport to exercise races, reconnects, and deadlines without depending on a
public relay.

## Game and data model

### Roster and identity

- A room has one stable creator identity and an ordered roster.
- Player records contain a stable ID, normalized unique name, join index,
  connection state, readiness, and `active` or `pending` round status.
- Starting a round snapshots the active ordered IDs. That snapshot never
  changes during the round. New players are visible as pending and join only
  when the creator starts the next round.
- Rejoining restores the existing player record instead of adding a duplicate.
  The exact authentication policy is an open question below.

### Books and stage assignment

For `N` frozen players, each book has exactly `N` entries:

1. Stage 0: every player supplies the text prompt for their own book.
2. Stage `k` (`1 <= k < N`): player `p` works on the book owned by
   `(p - k + N) mod N`, consuming only that book's immediately previous entry.
3. Odd-numbered stages are drawings; even-numbered stages are descriptions.
4. After stage `N - 1`, the player immediately before each book's owner has
   contributed and the round enters reveal mode.

This produces `N` simultaneous books and gives every player exactly one
contribution to every stage.

### Authoritative room state

- Room settings: prompt duration, drawing duration, room/round IDs, and current
  coordinator epoch.
- Roster: creator, frozen order, pending players, connection and submit status.
- Round: stage number/type, coordinator deadline timestamp, books, accepted
  submissions, and reveal position.
- Drafts: latest text or strokes received for each current assignment.
- Protocol messages: typed actions with player ID, round ID, stage ID, sequence
  number, and action ID so duplicates and stale messages are harmless.

The coordinator is authoritative for membership, deadlines, stage transitions,
and accepted submissions. Peers render from versioned snapshots and keep their
own current draft locally so a temporary connection interruption does not erase
work.

## Stage and deadline rules

- The coordinator announces an absolute deadline; clients display a countdown
  using a measured coordinator-clock offset.
- Text drafts are synchronized after changes and on blur. Drawing strokes are
  sent incrementally and checkpointed periodically.
- `Submit` freezes that player's accepted contribution for the stage and marks
  them complete.
- If everyone submits, the coordinator advances immediately.
- At timeout or creator force-advance:
  - submitted content wins;
  - otherwise the latest synchronized non-empty text draft wins;
  - an empty initial prompt becomes
    `"{Player Name} did not submit a prompt in time, draw what you think of them"`;
  - an empty later description remains an empty description unless we decide
    on a second fallback;
  - an unsubmitted drawing uses the latest synchronized strokes, including an
    intentionally blank canvas.
- Transitions are idempotent and keyed by round/stage, preventing late packets
  from modifying a completed stage.
- A peer that reconnects requests the latest snapshot, restores its assignment
  and local draft, and gets the remaining coordinator time.

## Screens and interaction

1. **Landing:** create room or join by room code and name.
2. **Lobby:** share code/link, show ordered active and pending players, creator
   settings, connection state, and start control.
3. **Text stage:** previous drawing when applicable, prompt input, countdown,
   submit button, and submission progress.
4. **Drawing stage:** source text, responsive fixed-aspect canvas, 16-color
   palette, 8 pen widths, undo/clear, countdown, submit, and progress.
5. **Reconnect/pending states:** clear non-destructive status and automatic
   resynchronization.
6. **Reveal:** synchronized book-by-book, entry-by-entry presentation with the
   contributing player's name, followed by creator controls for the next book
   and next round.

The interface will support mouse, touch, and pen input, keyboard navigation for
non-canvas controls, visible focus, reduced motion, and narrow mobile layouts.

## Admin controls

- Update durations while in the lobby or between rounds.
- Start a round with the currently active roster.
- Force-advance the current stage using the same deadline finalization rules.
- Drive the synchronized reveal.
- Start the next round, promoting connected pending players.
- End/reset the current round after confirmation.

Kicking players, transferring creator status, and acting-coordinator behavior
depend on the answers below.

## Reliability and limitations

- WebRTC still requires signaling and usually public STUN infrastructure.
  Trystero supplies discovery through third-party relays; those services are an
  external availability dependency even though this repository deploys only a
  static site.
- A peer-hosted game cannot provide server-grade trust. A determined player can
  inspect local JavaScript/state, forge client messages, or attempt to claim a
  name. The protocol will validate normal malformed/stale actions but is aimed
  at a trusted party-game group, not adversarial play.
- Full-mesh WebRTC and canvas synchronization impose a practical room-size
  limit. The initial recommendation is 3–12 players.
- State snapshots will be replicated sufficiently for reconnection/coordinator
  recovery. They remain local to room peers and browser storage; no analytics or
  permanent cloud game history is planned.

## Delivery phases

1. **Project foundation**
   - Scaffold Vite/React/TypeScript, linting, formatting, and tests.
   - Add the Pages workflow and repository-base-path handling.
   - Establish responsive visual tokens and accessible page structure.
2. **Deterministic game engine**
   - Define settings, roster, books, assignments, stages, timers, submissions,
     pending players, reconnects, reveal, and admin actions.
   - Add exhaustive reducer tests across player counts and stale/duplicate event
     cases.
3. **Networking and room lifecycle**
   - Add the transport interface and Trystero adapter.
   - Implement room creation/join, identity restoration, coordinator snapshots,
     heartbeats, clock sync, disconnect/reconnect, and conflict handling.
4. **Core user experience**
   - Implement landing, lobby, text stages, submission progress, deadlines,
     fallbacks, and admin controls.
5. **Drawing**
   - Implement pointer drawing, palette/width selection, undo/clear,
     serialization, synchronization, responsive redraw, and image presentation.
6. **Reveal and subsequent rounds**
   - Add synchronized reveals, pending-player promotion, settings updates, and
     next-round/reset flows.
7. **Hardening and release validation**
   - Test refresh/rejoin, disconnects, host behavior, duplicate names, delayed
     packets, narrow screens, touch drawing, and GitHub Pages deep-link reloads.
   - Run a real multi-browser WebRTC round and retain a video/screenshots as
     review evidence.

## Test plan

### Automated

- Unit-test assignment rotation and alternating content for every supported
  player count.
- Use fake clocks to test early completion, prompt/drawing timeouts, fallback
  prompts, force-advance, and exactly-once transitions.
- Test duplicate/stale/out-of-order messages and snapshot recovery.
- Test disconnect/rejoin and pending-player promotion at the next round.
- Test stroke serialization, coordinate normalization, undo, and responsive
  canvas replay.
- Run component accessibility and interaction tests for forms, progress,
  drawing tools, and admin controls.
- Drive at least four isolated Playwright clients through a complete round with
  the deterministic transport, verifying each resulting book and contributor.
- Build with the production GitHub Pages base path and validate the generated
  artifact.

### Manual end-to-end

- Open separate browser contexts as creator and at least three players.
- Join through the production Trystero transport and verify actual WebRTC peer
  connection state.
- Complete one full round containing text and drawing stages.
- Exercise one submitted item, one deadline-captured draft, the missing initial
  prompt fallback, and creator force-advance.
- Disconnect and rejoin a frozen player with the same identity mid-stage.
- Join a new player mid-round, confirm pending status, and promote them by
  starting the next round.
- Verify a completed synchronized reveal on desktop and a narrow touch-sized
  viewport.
- Record the successful walkthrough and capture the final reveal as review
  artifacts.

## Open questions

1. **Creator disconnects:** Should the game pause until the original creator
   returns, or should a deterministic acting coordinator keep timers/stages
   moving? Recommendation: elect an acting coordinator, retain creator-only
   admin rights, and restore coordination to the creator safely at a stage
   boundary.
2. **Name-only rejoin:** Reclaiming a seat using only the same room code and
   username means anyone can impersonate that player. Is that trust-based
   behavior intentional, including from a different device? Recommendation:
   persist a secret reconnect token automatically and require creator approval
   only when the token is unavailable.
3. **Player limits:** Is 3–12 players an acceptable supported range? The rules
   technically work for two, but the experience and full-mesh tradeoffs are
   better with at least three.
4. **Reveal flow:** Should the creator advance a shared reveal item-by-item, or
   should each player browse completed books independently? Recommendation:
   synchronized creator-led reveal, then unlock free browsing after all books.
5. **Submission editing:** Should `Submit` be final for the current stage, or
   may a player continue editing/resubmit until everyone submits or time
   expires? Recommendation: final submission, with a confirmation only for a
   blank canvas/description.
6. **Timer defaults and bounds:** What defaults and allowed range should the UI
   use? Recommendation: 60 seconds for prompts, 90 seconds for drawings, and a
   10–600 second range, editable between rounds.
7. **Round order:** Should player order stay fixed between rounds or be
   reshuffled when the creator starts the next round? Recommendation: keep join
   order by default and offer an explicit shuffle control.
8. **GitHub Pages:** The workflow can be committed here, but the repository may
   need **Settings → Pages → Source: GitHub Actions** enabled once. Is the
   standard repository URL sufficient, or is a custom domain required?
