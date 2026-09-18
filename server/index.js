import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8080)
// Behind nginx this binds to loopback. The LAN test path sets HOST=0.0.0.0.
const HOST = process.env.HOST || '0.0.0.0'
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')

// ---------------------------------------------------------------- ice config
// Served to both the host page and the desktop client so there is one source
// of truth for STUN/TURN. TURN_URLS is comma separated.
function iceServers () {
  const list = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',') }]
  if (process.env.TURN_URLS) {
    list.push({
      urls: process.env.TURN_URLS.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    })
  }
  return list
}

// ------------------------------------------------------------------- statics
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')

  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    return res.end(JSON.stringify({ iceServers: iceServers() }))
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = path.join(PUBLIC, rel)
  // Keep the join inside PUBLIC. Path traversal is cheap to block and expensive to explain.
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end() }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
})

// --------------------------------------------------------------------- rooms
// Map<code, { host?: WebSocket, agent?: WebSocket }>. No persistence, no auth.
const rooms = new Map()
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // no 0/O/1/I, codes get read aloud

function newCode () {
  let code
  do {
    code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')
  } while (rooms.has(code))
  return code
}

const other = role => (role === 'host' ? 'agent' : 'host')

function send (ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
}

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', ws => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.t === 'new') return send(ws, { t: 'code', room: newCode() })

    if (msg.t === 'join') {
      const role = msg.role === 'host' ? 'host' : 'agent'
      const code = String(msg.room || '').toUpperCase()
      if (code.length !== 6) return send(ws, { t: 'error', reason: 'bad code' })

      const room = rooms.get(code) || {}
      // Same role reconnecting replaces the old socket. Last agent in wins.
      if (room[role] && room[role] !== ws) {
        send(room[role], { t: 'error', reason: 'replaced' })
        room[role].close()
      }
      room[role] = ws
      rooms.set(code, room)
      ws.room = code
      ws.role = role

      send(ws, { t: 'joined', room: code, peer: !!room[other(role)] })
      send(room[other(role)], { t: 'peer', role, state: 'online' })
      return
    }

    // Everything else is relayed verbatim. The server never parses SDP.
    if (ws.room) {
      const room = rooms.get(ws.room)
      if (room) send(room[other(ws.role)], { ...msg, from: ws.role })
    }
  })

  ws.on('close', () => {
    const room = rooms.get(ws.room)
    if (!room || room[ws.role] !== ws) return
    delete room[ws.role]
    send(room[other(ws.role)], { t: 'peer', role: ws.role, state: 'offline' })
    if (!room.host && !room.agent) rooms.delete(ws.room)
  })
})

// Dead TCP connections otherwise hold rooms open forever.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, 15000).unref()

server.listen(PORT, HOST, () => console.log(`cueline signalling on ${HOST}:${PORT}`))
