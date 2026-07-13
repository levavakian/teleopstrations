# Teleopstrations

A serverless online drawing-and-guessing party game. Players exchange prompts,
drawings, and descriptions directly over WebRTC; the static application is
deployed to GitHub Pages.

## Play locally

```sh
npm install
npm run dev
```

Open the local URL in three or more browsers or devices. One player creates a
room and shares its eight-character code. The production network uses
[Trystero](https://trystero.dev/) with Nostr signaling and encrypted WebRTC data
channels.

For deterministic same-browser development without public signaling, append
`?transport=broadcast` to the URL before creating or joining a room.

## Game flow

1. The room admin sets prompt and drawing deadlines and starts a round.
2. The connected roster is shuffled and frozen; later arrivals wait for the
   next round.
3. Everyone writes an opening prompt.
4. Books rotate through alternating drawing and description stages until every
   frozen player has contributed to every book.
5. Each prompt owner presents their playbook, with the room creator sharing
   reveal controls.

Submissions may be replaced until the deadline or until everyone has submitted,
which advances the stage immediately. If an opening prompt is still empty, the
game creates the configured player-name fallback. The room creator remains the
only state authority; clients queue work and wait for that creator to reconnect
instead of electing a replacement. Creators can end a round early, kick players
between rounds, or close the room for all connected peers.

Snapshots are authoritative only when attributed to the current creator session.
Updates and 15-second sync requests use bounded gossip so a partially connected
peer graph can converge without an application server. The creator can expand the
sync report to compare each player’s phase, stage, and reveal cursor.
Reveal pages can be exported as a single PNG playbook, and drawings can be
opened in a full-screen viewer while writing descriptions.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Type-check and build the static site |
| `npm run lint` | Run ESLint |
| `npm test` | Run unit and integration tests |
| `npm run test:e2e` | Run multi-player browser tests |
| `npm run preview` | Preview the production build |

## Deployment

`.github/workflows/deploy.yml` verifies pull requests and deploys `main` through
GitHub Pages. The Vite production build uses `/teleopstrations/` as its base
path. GitHub Pages must use **GitHub Actions** as its source.

## Architecture and limitations

The implementation plan is in [`PLAN.md`](./PLAN.md), and the protocol
invariants and recovery design are in [`NETWORKING.md`](./NETWORKING.md).
There is intentionally no configured maximum player count, but browser
full-mesh WebRTC and full-state replication impose practical device/network
limits. This is a trusted party game: name-only rejoining and replicated hidden
content are not designed to resist malicious players.
The creator is the canonical state writer. Other clients receive pushed snapshots,
poll every 15 seconds, and relay bounded gossip through connected peers when a
direct creator edge is unavailable.
The static deployment has no TURN relay, so a device that cannot connect to any
peer can still be isolated on a restrictive network. TURN requires an external
service with short-lived credentials; permanent credentials must not be shipped
in the Pages bundle.
Rooms are ephemeral: closing one broadcasts a tombstone to connected peers and
clears its round, while permanent deletion cannot exist without a server.
