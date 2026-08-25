# Teleopstrations

An online drawing-and-guessing party game. A lightweight Node server owns
every room's state in memory and pushes it to players over WebSockets; the
React client and the server deploy together as a single [Render](https://render.com)
web service straight from this repository.

## Deploy to Render

The repo contains a [`render.yaml`](./render.yaml) blueprint, so no manual
service configuration is needed:

1. In the Render dashboard choose **New → Blueprint** and select this
   repository (or open `https://dashboard.render.com/blueprints` and connect
   the repo).
2. Render reads `render.yaml`, creates one free-plan web service, builds with
   `npm ci && npm run build`, and starts `npm run start`.
3. Enable auto-deploy from `main` (on by default for blueprints); every push
   to `main` redeploys.

Notes on the in-memory design:

- Rooms live only in server memory. A room with no human activity (joins or
  game actions) for **one day** is deleted automatically.
- Every deploy or restart starts with empty memory. The room creator's open
  tab automatically recreates its room (same code and settings) when it
  reconnects, and other players' tabs keep retrying until it reappears —
  but any in-progress round is lost.
- On the free plan, Render spins the service down after ~15 idle minutes,
  which also wipes memory; the first visit afterwards takes a few seconds to
  wake the service.

## Play locally

```sh
npm install
npm run dev:server   # game server on :8787
npm run dev          # Vite dev server (proxies /ws to :8787)
```

Open the Vite URL in three or more tabs or devices. One player creates a
room and shares its eight-character code or the invite link. To exercise the
production stack instead, run `npm run build && npm run start` and open
`http://localhost:8787`.

## Game flow

1. The room creator (the admin) sets prompt and drawing deadlines and starts
   a round.
2. The connected roster is shuffled and frozen; later arrivals wait for the
   next round.
3. Everyone writes an opening prompt.
4. Books rotate through alternating drawing and description stages until
   every frozen player has contributed to every book.
5. Each prompt owner presents their playbook, with the admin sharing reveal
   controls.

Submissions may be replaced until the deadline or until everyone has
submitted, which advances the stage immediately. If an opening prompt is
still empty, the game creates the configured player-name fallback. The admin
can force-advance a stage, end a round early, kick players between rounds,
or close the room for everyone.

Identity is name-based: rejoining a room with the same name reclaims that
player's seat mid-round, and rejoining with the creator's name makes you the
admin again — from any device. The newest connection for a name always wins
the seat; the older tab is told its seat moved. Deadlines advance on the
server, so the game keeps moving even while the admin is offline.

In-progress drafts are uploaded (throttled) so the deadline can capture
unsubmitted work, but they stay server-side: state pushed to players never
contains another player's draft, keeping stage traffic small. The admin can
expand the player sync panel to see who is on the current page. Reveal pages
can be exported as a single PNG playbook, and drawings can be opened in a
full-screen viewer while writing descriptions.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server (client) |
| `npm run dev:server` | Start the game server with reload on change |
| `npm run build` | Type-check, build the client bundle and the server |
| `npm run start` | Serve the built app and the game endpoint |
| `npm run lint` | Run ESLint |
| `npm test` | Run unit and server integration tests |
| `npm run test:e2e` | Run multi-player browser tests against the real server |

## Architecture

- `server/index.ts` — HTTP + WebSocket entry point: serves the built client,
  `/healthz`, and the `/ws` game endpoint; terminates dead sockets with
  protocol-level heartbeats.
- `server/rooms.ts` — the room manager: applies every intent serially
  through the shared game reducer, broadcasts redacted state on visible
  changes, sends a 1 Hz tick (server time + player sync reports), advances
  stage deadlines, and expires idle rooms.
- `src/game.ts` — the pure game reducer, shared by server and client.
- `src/serverProtocol.ts` — the WebSocket message types, shared by both.
- `src/useGameRoom.ts` — the client: joins over WebSocket, reconnects with
  backoff, queues intents while offline, throttles draft uploads, and keeps
  countdowns honest with ping/pong clock sync.

`.github/workflows/ci.yml` lints, builds, and runs every test suite on
pushes to `main` and on pull requests; hosting is Render's auto-deploy.

This is a trusted party game: name-only identity and server-held hidden
content are not designed to resist malicious players. There is intentionally
no configured maximum player count, but full-state pushes impose practical
limits. The original peer-to-peer implementation plan is preserved in
[`PLAN.md`](./PLAN.md) for history.
