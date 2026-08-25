import {createServer} from 'node:http'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import express from 'express'
import {WebSocket, WebSocketServer} from 'ws'

import {RoomManager, type ManagedClient} from './rooms'

const PORT = Number(process.env.PORT ?? 8787)
const PUMP_INTERVAL_MS = 250
const SOCKET_HEARTBEAT_MS = 30_000
/** Cap inbound frames well above the largest legal room state. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const app = express()
app.disable('x-powered-by')
app.get('/healthz', (_request, response) => {
  response.json({ok: true, rooms: manager.roomCount})
})
app.use(express.static(distDir, {index: 'index.html', maxAge: '1h'}))
// Single-page app: every other path serves the client shell.
app.use((_request, response) => {
  response.sendFile(join(distDir, 'index.html'))
})

const server = createServer(app)
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES,
})
const manager = new RoomManager()

interface LiveSocket extends WebSocket {
  isAlive?: boolean
}

wss.on('connection', (socket: LiveSocket) => {
  const client: ManagedClient = {
    send(message) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message))
      }
    },
    close() {
      socket.close()
    },
  }
  socket.isAlive = true
  socket.on('pong', () => {
    socket.isAlive = true
  })
  socket.on('message', (data) => {
    manager.handleMessage(client, data.toString())
  })
  socket.on('close', () => manager.disconnect(client))
  socket.on('error', () => socket.close())
})

setInterval(() => manager.pump(), PUMP_INTERVAL_MS)

// Protocol-level heartbeat: terminate sockets that stopped answering pings
// (browser killed, network gone) so their players show as disconnected.
setInterval(() => {
  for (const socket of wss.clients as Set<LiveSocket>) {
    if (socket.isAlive === false) {
      socket.terminate()
      continue
    }
    socket.isAlive = false
    socket.ping()
  }
}, SOCKET_HEARTBEAT_MS)

server.listen(PORT, () => {
  console.log(`teleopstrations server listening on :${PORT}`)
})
