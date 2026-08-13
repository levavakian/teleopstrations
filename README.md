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

1. The room host sets prompt and drawing deadlines and starts a round.
2. The connected roster is shuffled and frozen; later arrivals wait for the
   next round.
3. Everyone writes an opening prompt.
4. Books rotate through alternating drawing and description stages until every
   frozen player has contributed to every book.
5. Each prompt owner presents their playbook, with the room host sharing
   reveal controls.

Submissions may be replaced until the deadline or until everyone has submitted,
which advances the stage immediately. If an opening prompt is still empty, the
game creates the configured player-name fallback. Hosts can end a round early,
kick players between rounds, or close the room for all connected peers.

The room creator's tab acts as the game server: clients talk only to it, it
pushes ordered state updates instantly, and a 1 Hz tick keeps countdowns and
pages aligned everywhere. If the host tab closes, rejoining the same room code
with the same name from the same browser resumes the room exactly where it
left off; meanwhile clients keep their work queued locally and deliver it when
the host returns. The host can expand the player sync panel to see who is on
the current page. Reveal pages can be exported as a single PNG playbook, and
drawings can be opened in a full-screen viewer while writing descriptions.

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

The implementation plan is in [`PLAN.md`](./PLAN.md), and the host/client
protocol, timer sync, and resume design are in [`NETWORKING.md`](./NETWORKING.md).
There is intentionally no configured maximum player count, but browser WebRTC
and full-state pushes impose practical device/network limits. This is a
trusted party game: name-only rejoining and host-held hidden content are not
designed to resist malicious players.
The room creator is the permanent host and single state writer; there is no
host election or transfer, only resume-by-rejoining from the same browser.
The static deployment ships no TURN relay, so whether a direct link forms
depends on both networks cooperating (phone carrier NAT is the worst case) —
connections can succeed one attempt and fail the next. No provider offers
credential-free TURN (`scripts/probe-turn.mjs` verifies the well-known
"public" relays are dead), so the fix is self-service: one player pastes free
credentials from a provider such as Metered or ExpressTURN under "Connection
help", and invite links copied from that device carry the settings to every
player who opens them.
To raise the odds without TURN, the app adds STUN servers across diverse
providers and ports (80/443/3478) on top of the defaults, and clients rebuild
their transport within seconds — instead of waiting out the silence window —
when WebRTC itself reports the host link as dead, since every rebuild is a
fresh hole-punching attempt. Fruitless rebuilds back off exponentially:
every rejoin bursts announce events to the signaling relays, and a client
retrying a dead room forever would otherwise trip relay rate limits.
Rooms are ephemeral: closing one broadcasts a tombstone to connected peers and
clears its round, while permanent deletion cannot exist without a server.
