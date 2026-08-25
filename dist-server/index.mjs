// server/index.ts
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

// src/game.ts
var MIN_PLAYERS = 3;
var MAX_ROOM_STATE_CHARS = 35e5;
var MAX_TIMER_SECONDS = 8e12;
function normalizeName(name) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ");
}
function playerIdForName(name) {
  return normalizeName(name).toLocaleLowerCase("en-US");
}
function normalizeRoomCode(code) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
function createId() {
  return crypto.randomUUID();
}
function isValidSettings(settings) {
  return Number.isSafeInteger(settings.promptSeconds) && settings.promptSeconds > 0 && settings.promptSeconds <= MAX_TIMER_SECONDS && Number.isSafeInteger(settings.drawingSeconds) && settings.drawingSeconds > 0 && settings.drawingSeconds <= MAX_TIMER_SECONDS;
}
function copyState(state) {
  return structuredClone(state);
}
function stageKind(stageIndex) {
  return stageIndex % 2 === 0 ? "text" : "drawing";
}
function stageDuration(state, stageIndex) {
  return (stageKind(stageIndex) === "text" ? state.settings.promptSeconds : state.settings.drawingSeconds) * 1e3;
}
function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
function makeAssignments(order, stageIndex) {
  return Object.fromEntries(
    order.map((playerId, playerIndex) => {
      const ownerIndex = (playerIndex - stageIndex + order.length) % order.length;
      return [
        playerId,
        {
          playerId,
          bookOwnerId: order[ownerIndex],
          kind: stageKind(stageIndex),
          draft: null,
          submission: null
        }
      ];
    })
  );
}
function createInitialRoom(roomCode, creator, settings) {
  if (!isValidSettings(settings)) {
    throw new Error("Timers must be positive whole numbers.");
  }
  const player = {
    ...creator,
    joinIndex: 0,
    connected: true
  };
  return {
    protocolVersion: 3,
    roomCode: normalizeRoomCode(roomCode),
    creatorId: creator.id,
    revision: 0,
    settings,
    players: { [creator.id]: player },
    joinOrder: [creator.id],
    blockedPlayerIds: [],
    closedAt: null,
    phase: "lobby",
    round: null
  };
}
function joinPlayer(state, session) {
  if (state.phase === "closed" || state.blockedPlayerIds.includes(session.id)) {
    return state;
  }
  const next = copyState(state);
  const existing = next.players[session.id];
  if (existing) {
    const incomingIsNewer = session.sessionStartedAt > existing.sessionStartedAt || session.sessionStartedAt === existing.sessionStartedAt && session.sessionId >= existing.sessionId;
    if (!incomingIsNewer) return state;
    existing.name = session.name;
    existing.sessionId = session.sessionId;
    existing.sessionStartedAt = session.sessionStartedAt;
    existing.connected = true;
    const assignment = next.round?.assignments[session.id];
    if (assignment) {
      if (assignment.draft) {
        assignment.draft = {
          ...assignment.draft,
          seq: 0,
          sessionId: session.sessionId
        };
      }
      if (assignment.submission) {
        assignment.submission = {
          ...assignment.submission,
          seq: 0,
          sessionId: session.sessionId
        };
      }
    }
  } else {
    next.players[session.id] = {
      ...session,
      joinIndex: next.joinOrder.length,
      connected: true
    };
    next.joinOrder.push(session.id);
  }
  next.revision += 1;
  return next;
}
function setPlayerConnected(state, playerId, connected) {
  const player = state.players[playerId];
  if (!player || player.connected === connected) return state;
  const next = copyState(state);
  next.players[playerId].connected = connected;
  next.revision += 1;
  return next;
}
function startRound(state, now, random = Math.random) {
  const eligible = state.joinOrder.filter(
    (playerId) => state.players[playerId]?.connected
  );
  if (eligible.length < MIN_PLAYERS) return state;
  const next = copyState(state);
  const order = shuffle(eligible, random);
  const roundNumber = (next.round?.number ?? 0) + 1;
  const books = Object.fromEntries(
    order.map((ownerId) => [
      ownerId,
      { ownerId, entries: [] }
    ])
  );
  next.phase = "stage";
  next.round = {
    id: createId(),
    number: roundNumber,
    order,
    stageIndex: 0,
    deadline: now + stageDuration(next, 0),
    assignments: makeAssignments(order, 0),
    books,
    reveal: null
  };
  next.revision += 1;
  return next;
}
function sameCandidateSession(state, playerId, candidate) {
  return state.players[playerId]?.sessionId === candidate.sessionId;
}
function isValidContent(content) {
  if (!content || typeof content !== "object") return false;
  if (content.kind === "text") {
    return typeof content.text === "string" && content.text.length <= 280;
  }
  if (content.kind !== "drawing" || !Array.isArray(content.strokes)) {
    return false;
  }
  if (content.strokes.length > 1e3) return false;
  let pointCount = 0;
  for (const stroke of content.strokes) {
    if (!stroke || typeof stroke !== "object" || typeof stroke.id !== "string" || stroke.id.length > 128 || !Number.isInteger(stroke.color) || stroke.color < 0 || stroke.color >= 16 || !Number.isInteger(stroke.size) || stroke.size < 0 || stroke.size >= 8 || !Array.isArray(stroke.points) || stroke.points.length > 5e3) {
      return false;
    }
    pointCount += stroke.points.length;
    if (pointCount > 5e4) return false;
    for (const point of stroke.points) {
      if (!point || typeof point !== "object" || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.pressure) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || point.pressure < 0 || point.pressure > 1) {
        return false;
      }
    }
  }
  return true;
}
function applyCandidate(state, envelope, kind) {
  const round = state.round;
  const intent = envelope.intent;
  if (!round || state.phase !== "stage" || intent.type !== "draft" && intent.type !== "submit" || intent.roundId !== round.id || intent.stageIndex !== round.stageIndex || !intent.candidate || typeof intent.candidate !== "object" || !Number.isFinite(intent.candidate.seq) || envelope.sessionId !== intent.candidate.sessionId || !sameCandidateSession(state, envelope.senderId, intent.candidate) || !isValidContent(intent.candidate.content)) {
    return state;
  }
  const assignment = round.assignments[envelope.senderId];
  if (!assignment || assignment.kind !== intent.candidate.content.kind || kind !== intent.type) {
    return state;
  }
  const field = kind === "draft" ? "draft" : "submission";
  const current = assignment[field];
  if (current && current.sessionId === intent.candidate.sessionId && current.seq >= intent.candidate.seq) {
    return state;
  }
  const next = copyState(state);
  next.round.assignments[envelope.senderId][field] = intent.candidate;
  try {
    if (JSON.stringify(next).length > MAX_ROOM_STATE_CHARS) return state;
  } catch {
    return state;
  }
  if (kind !== "draft") next.revision += 1;
  return next;
}
function redactStateForWire(state, keepDraftsFor) {
  const round = state.round;
  if (!round) return state;
  const hasForeignDraft = Object.values(round.assignments).some(
    (assignment) => assignment.draft && assignment.playerId !== keepDraftsFor
  );
  if (!hasForeignDraft) return state;
  return {
    ...state,
    round: {
      ...round,
      assignments: Object.fromEntries(
        Object.entries(round.assignments).map(([playerId, assignment]) => [
          playerId,
          playerId === keepDraftsFor ? assignment : { ...assignment, draft: null }
        ])
      )
    }
  };
}
function isCreatorControl(state, senderId) {
  return senderId === state.creatorId;
}
function currentRevealOwner(state) {
  const round = state.round;
  if (!round?.reveal) return null;
  return round.order[round.reveal.bookIndex] ?? null;
}
function canControlReveal(state, senderId) {
  return senderId === state.creatorId || senderId === currentRevealOwner(state);
}
function applyIntent(state, envelope, now, random = Math.random) {
  const player = state.players[envelope.senderId];
  if (!player || player.sessionId !== envelope.sessionId) return state;
  const intent = envelope.intent;
  if (intent.type === "draft" || intent.type === "submit") {
    return applyCandidate(state, envelope, intent.type);
  }
  if (intent.type === "close-room") {
    return isCreatorControl(state, envelope.senderId) && intent.roomCode === state.roomCode ? closeRoom(state, now) : state;
  }
  if (intent.type === "settings") {
    const betweenRounds = state.phase === "lobby" || state.phase === "reveal" && Boolean(state.round?.reveal?.complete);
    if (!isCreatorControl(state, envelope.senderId) || !betweenRounds || !isValidSettings(intent.settings)) {
      return state;
    }
    const next = copyState(state);
    next.settings = intent.settings;
    next.revision += 1;
    return next;
  }
  if (intent.type === "start-round") {
    const validPhase = state.phase === "lobby" && intent.expectedPhase === "lobby" && intent.previousRoundId === null || state.phase === "reveal" && state.round?.reveal?.complete && intent.expectedPhase === "reveal" && intent.previousRoundId === state.round.id;
    return isCreatorControl(state, envelope.senderId) && validPhase ? startRound(state, now, random) : state;
  }
  if (intent.type === "force-advance") {
    return isCreatorControl(state, envelope.senderId) && state.phase === "stage" && state.round?.id === intent.roundId && state.round.stageIndex === intent.stageIndex ? advanceStage(state, now) : state;
  }
  if (intent.type === "end-round") {
    return isCreatorControl(state, envelope.senderId) && state.phase === "stage" && state.round?.id === intent.roundId && state.round.stageIndex === intent.stageIndex ? endRound(state) : state;
  }
  if (intent.type === "kick-player") {
    const validPhase = state.phase === "lobby" && intent.expectedPhase === "lobby" && intent.previousRoundId === null || state.phase === "reveal" && state.round?.reveal?.complete && intent.expectedPhase === "reveal" && intent.previousRoundId === state.round.id;
    return isCreatorControl(state, envelope.senderId) && validPhase ? kickPlayer(state, intent.playerId) : state;
  }
  if (intent.type === "reset-lobby") {
    if (!isCreatorControl(state, envelope.senderId) || !state.round || intent.roundId !== state.round.id) {
      return state;
    }
    const next = copyState(state);
    next.phase = "lobby";
    next.round = null;
    next.revision += 1;
    return next;
  }
  if (state.phase !== "reveal" || !state.round?.reveal || !canControlReveal(state, envelope.senderId)) {
    return state;
  }
  if (intent.type === "reveal-page") {
    const book = getCurrentRevealBook(state);
    if (!book || intent.roundId !== state.round.id || intent.bookIndex !== state.round.reveal.bookIndex) {
      return state;
    }
    const next = copyState(state);
    next.round.reveal.pageIndex = Math.max(
      0,
      Math.min(intent.pageIndex, book.entries.length - 1)
    );
    next.revision += 1;
    return next;
  }
  if (intent.type === "reveal-book") {
    if (intent.roundId !== state.round.id || intent.bookIndex !== state.round.reveal.bookIndex) {
      return state;
    }
    const next = copyState(state);
    const reveal = next.round.reveal;
    const target = reveal.bookIndex + intent.direction;
    if (target < 0) return state;
    if (target >= next.round.order.length) {
      reveal.complete = true;
      reveal.pageIndex = next.round.books[next.round.order[reveal.bookIndex]].entries.length - 1;
    } else {
      reveal.bookIndex = target;
      reveal.pageIndex = 0;
      reveal.complete = false;
    }
    next.revision += 1;
    return next;
  }
  return state;
}
function blankContent(kind) {
  return kind === "text" ? { kind: "text", text: "" } : { kind: "drawing", strokes: [] };
}
function finalizedContent(state, assignment) {
  const candidate = assignment.submission ?? assignment.draft;
  const selectedSource = assignment.submission ? "submission" : "draft";
  const player = state.players[assignment.playerId];
  if (candidate) {
    if (state.round?.stageIndex === 0 && candidate.content.kind === "text" && !candidate.content.text.trim()) {
      return {
        content: {
          kind: "text",
          text: `${player.name} did not submit a prompt in time, draw what you think of them`
        },
        source: "fallback"
      };
    }
    return { content: candidate.content, source: selectedSource };
  }
  if (state.round?.stageIndex === 0) {
    return {
      content: {
        kind: "text",
        text: `${player.name} did not submit a prompt in time, draw what you think of them`
      },
      source: "fallback"
    };
  }
  return { content: blankContent(assignment.kind), source: "blank" };
}
function currentStageIsFinalized(state) {
  return Boolean(
    state.round && Object.values(state.round.books).some(
      (book) => book.entries.some(
        ({ stageIndex }) => stageIndex === state.round.stageIndex
      )
    )
  );
}
function finalizeCurrentStage(next) {
  const round = next.round;
  const completedStage = round.stageIndex;
  for (const playerId of round.order) {
    const assignment = round.assignments[playerId];
    const result = finalizedContent(next, assignment);
    round.books[assignment.bookOwnerId].entries.push({
      stageIndex: completedStage,
      authorId: playerId,
      ...result
    });
  }
}
function enterReveal(next) {
  next.phase = "reveal";
  next.round.deadline = 0;
  next.round.assignments = {};
  next.round.reveal = { bookIndex: 0, pageIndex: 0, complete: false };
}
function advanceStage(state, now) {
  if (state.phase !== "stage" || !state.round || currentStageIsFinalized(state)) {
    return state;
  }
  const next = copyState(state);
  const round = next.round;
  const completedStage = round.stageIndex;
  finalizeCurrentStage(next);
  if (completedStage >= round.order.length - 1) {
    enterReveal(next);
  } else {
    round.stageIndex += 1;
    round.assignments = makeAssignments(round.order, round.stageIndex);
    round.deadline = now + stageDuration(next, round.stageIndex);
  }
  next.revision += 1;
  return next;
}
function endRound(state) {
  if (state.phase !== "stage" || !state.round || currentStageIsFinalized(state)) {
    return state;
  }
  const next = copyState(state);
  finalizeCurrentStage(next);
  enterReveal(next);
  next.revision += 1;
  return next;
}
function kickPlayer(state, playerId) {
  const betweenRounds = state.phase === "lobby" || state.phase === "reveal" && Boolean(state.round?.reveal?.complete);
  if (!betweenRounds || !state.players[playerId] || playerId === state.creatorId) {
    return state;
  }
  const next = copyState(state);
  next.players[playerId].connected = false;
  next.joinOrder = next.joinOrder.filter((id) => id !== playerId);
  if (!next.blockedPlayerIds.includes(playerId)) {
    next.blockedPlayerIds.push(playerId);
  }
  next.revision += 1;
  return next;
}
function closeRoom(state, now) {
  if (state.phase === "closed") return state;
  const next = copyState(state);
  next.phase = "closed";
  next.round = null;
  next.closedAt = now;
  next.revision += 1;
  return next;
}
function getCurrentRevealBook(state) {
  const round = state.round;
  if (!round?.reveal) return null;
  const ownerId = round.order[round.reveal.bookIndex];
  return round.books[ownerId] ?? null;
}
function getSubmissionCount(state) {
  if (state.phase !== "stage" || !state.round) return 0;
  return Object.values(state.round.assignments).filter(
    (assignment) => assignment.submission
  ).length;
}

// src/serverProtocol.ts
function isRecord(value) {
  return Boolean(value) && typeof value === "object";
}
function isSessionShape(value) {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.name === "string" && value.name.length <= 64 && typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 128 && typeof value.sessionStartedAt === "number" && Number.isFinite(value.sessionStartedAt);
}
function parseClientMessage(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "join":
      return typeof value.roomCode === "string" && value.roomCode.length <= 16 && typeof value.create === "boolean" && isSessionShape(value.player) && (value.settings === void 0 || isRecord(value.settings)) ? value : null;
    case "intent":
      return isRecord(value.intent) && typeof value.intent.type === "string" ? value : null;
    case "cursor":
      return isRecord(value.cursor) ? value : null;
    case "ping":
      return typeof value.id === "string" && value.id.length <= 64 && typeof value.clientTime === "number" ? value : null;
    default:
      return null;
  }
}

// server/rooms.ts
var ROOM_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1e3;
var CLOSED_ROOM_GRACE_MS = 6e4;
var TICK_INTERVAL_MS = 1e3;
var RoomManager = class {
  rooms = /* @__PURE__ */ new Map();
  connections = /* @__PURE__ */ new Map();
  now;
  constructor(now = Date.now) {
    this.now = now;
  }
  get roomCount() {
    return this.rooms.size;
  }
  handleMessage(client, raw) {
    const message = parseClientMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "join":
        this.handleJoin(client, message);
        return;
      case "intent":
        this.handleIntent(client, message);
        return;
      case "cursor":
        this.handleCursor(client, message);
        return;
      case "ping":
        client.send({
          type: "pong",
          id: message.id,
          clientTime: message.clientTime,
          serverTime: this.now()
        });
        return;
    }
  }
  disconnect(client) {
    const connection = this.connections.get(client);
    if (!connection) return;
    this.connections.delete(client);
    const room = this.rooms.get(connection.roomCode);
    if (!room) return;
    room.clients.delete(client);
    const playerId = connection.session.id;
    const stillConnected = Array.from(room.clients).some(
      (other) => this.connections.get(other)?.session.id === playerId
    );
    if (!stillConnected && room.state.players[playerId]) {
      const next = setPlayerConnected(room.state, playerId, false);
      if (next !== room.state) {
        room.state = next;
        this.broadcastState(room);
      }
    }
  }
  /** Advances stage deadlines, sends ticks, and cleans up idle rooms. */
  pump(nowMs = this.now()) {
    for (const [code, room] of this.rooms) {
      if (room.state.phase === "closed" && room.state.closedAt !== null && nowMs - room.state.closedAt >= CLOSED_ROOM_GRACE_MS) {
        this.deleteRoom(code, room);
        continue;
      }
      if (nowMs - room.lastActivityAt >= ROOM_IDLE_TIMEOUT_MS) {
        room.state = closeRoom(room.state, nowMs);
        this.broadcastState(room);
        this.deleteRoom(code, room);
        continue;
      }
      if (room.state.phase === "stage" && room.state.round && nowMs >= room.state.round.deadline) {
        room.state = advanceStage(room.state, nowMs);
        this.broadcastState(room);
      }
      if (nowMs - room.lastTickAt >= TICK_INTERVAL_MS) {
        room.lastTickAt = nowMs;
        const tick = {
          type: "tick",
          serverTime: nowMs,
          reports: room.reports
        };
        for (const client of room.clients) client.send(tick);
      }
    }
  }
  handleJoin(client, message) {
    const nowMs = this.now();
    const roomCode = normalizeRoomCode(message.roomCode);
    const name = normalizeName(message.player.name);
    if (roomCode.length !== 8 || !name) {
      client.send({
        type: "join-error",
        code: "invalid",
        message: "That room code or name is not usable."
      });
      return;
    }
    const playerId = playerIdForName(name);
    let room = this.rooms.get(roomCode);
    if (!room) {
      if (!message.create || !message.settings || !isValidSettings(message.settings)) {
        client.send({
          type: "join-error",
          code: "not-found",
          message: "This room is not live. It may have expired, or the server may have restarted \u2014 the creator can bring it back by reopening their tab or creating it again."
        });
        return;
      }
      const creator = {
        id: playerId,
        name,
        sessionId: message.player.sessionId,
        sessionStartedAt: nowMs
      };
      room = {
        state: createInitialRoom(roomCode, creator, message.settings),
        clients: /* @__PURE__ */ new Set(),
        reports: {},
        lastActivityAt: nowMs,
        lastTickAt: nowMs
      };
      this.rooms.set(roomCode, room);
    }
    if (room.state.blockedPlayerIds.includes(playerId)) {
      client.send({
        type: "join-error",
        code: "blocked",
        message: "You have been removed from this room."
      });
      return;
    }
    const existing = room.state.players[playerId];
    const session = {
      id: playerId,
      name,
      sessionId: message.player.sessionId,
      sessionStartedAt: existing ? Math.max(nowMs, existing.sessionStartedAt + 1) : nowMs
    };
    const next = joinPlayer(room.state, session);
    if (next === room.state && !existing) {
      client.send({
        type: "join-error",
        code: "not-found",
        message: "This room has been shut down."
      });
      return;
    }
    for (const other of room.clients) {
      if (other === client) continue;
      if (this.connections.get(other)?.session.id === playerId) {
        other.send({ type: "superseded" });
        room.clients.delete(other);
        this.connections.delete(other);
        other.close();
      }
    }
    room.state = next;
    room.lastActivityAt = nowMs;
    this.connections.set(client, { roomCode, session });
    room.clients.add(client);
    client.send({
      type: "joined",
      state: redactStateForWire(room.state, playerId),
      serverTime: nowMs
    });
    this.broadcastState(room, client);
  }
  handleIntent(client, message) {
    const connection = this.connections.get(client);
    if (!connection) return;
    const room = this.rooms.get(connection.roomCode);
    if (!room) return;
    const nowMs = this.now();
    room.lastActivityAt = nowMs;
    const envelope = {
      id: crypto.randomUUID(),
      senderId: connection.session.id,
      sessionId: connection.session.sessionId,
      intent: message.intent
    };
    const current = room.state;
    let next = applyIntent(current, envelope, nowMs);
    if (envelope.intent.type === "submit" && next.phase === "stage" && next.round && getSubmissionCount(next) === next.round.order.length) {
      next = advanceStage(next, nowMs);
    }
    if (next === current) return;
    const stageTransitioned = next.phase !== current.phase || next.round?.stageIndex !== current.round?.stageIndex;
    room.state = next;
    if (envelope.intent.type === "draft" && !stageTransitioned) return;
    this.broadcastState(room);
  }
  handleCursor(client, message) {
    const connection = this.connections.get(client);
    if (!connection) return;
    const room = this.rooms.get(connection.roomCode);
    if (!room) return;
    const player = room.state.players[connection.session.id];
    if (!player || player.sessionId !== connection.session.sessionId) return;
    room.reports[connection.session.id] = {
      playerId: connection.session.id,
      sessionId: connection.session.sessionId,
      cursor: message.cursor,
      receivedAt: this.now()
    };
  }
  broadcastState(room, except) {
    const message = {
      type: "state",
      state: redactStateForWire(room.state),
      serverTime: this.now()
    };
    for (const client of room.clients) {
      if (client !== except) client.send(message);
    }
  }
  deleteRoom(code, room) {
    for (const client of room.clients) {
      this.connections.delete(client);
      client.close();
    }
    room.clients.clear();
    this.rooms.delete(code);
  }
};

// server/index.ts
var PORT = Number(process.env.PORT ?? 8787);
var PUMP_INTERVAL_MS = 250;
var SOCKET_HEARTBEAT_MS = 3e4;
var MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
var distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
var app = express();
app.disable("x-powered-by");
app.get("/healthz", (_request, response) => {
  response.json({ ok: true, rooms: manager.roomCount });
});
app.use(express.static(distDir, { index: "index.html", maxAge: "1h" }));
app.use((_request, response) => {
  response.sendFile(join(distDir, "index.html"));
});
var server = createServer(app);
var wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_MESSAGE_BYTES
});
var manager = new RoomManager();
wss.on("connection", (socket) => {
  const client = {
    send(message) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
    close() {
      socket.close();
    }
  };
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("message", (data) => {
    manager.handleMessage(client, data.toString());
  });
  socket.on("close", () => manager.disconnect(client));
  socket.on("error", () => socket.close());
});
setInterval(() => manager.pump(), PUMP_INTERVAL_MS);
setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, SOCKET_HEARTBEAT_MS);
server.listen(PORT, () => {
  console.log(`teleopstrations server listening on :${PORT}`);
});
