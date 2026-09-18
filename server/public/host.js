const $ = id => document.getElementById(id)
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'

const { iceServers } = await fetch('/config.json').then(r => r.json())

let ws, pc, dc, room = location.hash.slice(1).toUpperCase()
let ctx, pending = []

// ------------------------------------------------------------------- logging
function line (text, cls = 'sys') {
  const el = Object.assign(document.createElement('div'), { className: cls, textContent: text })
  $('log').append(el)
  $('log').scrollTop = $('log').scrollHeight
}

function presence (online) {
  $('dot').classList.toggle('on', online)
  $('presence').textContent = online ? 'agent online' : 'agent offline'
  if (!online) { $('rtt').textContent = ''; setMeter('mic', 0); setMeter('sys', 0) }
}

// ----------------------------------------------------------------- signalling
function connect () {
  ws = new WebSocket(WS_URL)
  ws.onopen = () => room ? join() : ws.send(JSON.stringify({ t: 'new' }))
  ws.onclose = () => { presence(false); line('signalling lost, retrying'); setTimeout(connect, 2000) }
  ws.onmessage = e => handle(JSON.parse(e.data))
}

function join () {
  location.hash = room
  $('code').textContent = room
  ws.send(JSON.stringify({ t: 'join', room, role: 'host' }))
}

const signal = data => ws.send(JSON.stringify({ t: 'signal', data }))

async function handle (msg) {
  switch (msg.t) {
    case 'code': room = msg.room; return join()
    case 'joined': return presence(msg.peer)
    case 'peer': return presence(msg.state === 'online')
    case 'perm': return line(`agent needs ${msg.what} access`)
    case 'error': return line(`server: ${msg.reason}`)
    case 'signal': return onSignal(msg.data).catch(e => line(`negotiation failed: ${e.message}`))
  }
}

async function onSignal (data) {
  if (data.sdp) {
    // Every offer builds a fresh peer connection. No renegotiation, no glare.
    if (pc) pc.close()
    resetPlayback()
    pc = newPeer()
    await pc.setRemoteDescription(data.sdp)
    for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
    const answer = await pc.createAnswer()
    assertRecvOnly(answer.sdp)
    await pc.setLocalDescription(answer)
    signal({ sdp: pc.localDescription })
  } else if (data.ice) {
    if (pc?.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => {})
    else pending.push(data.ice)
  }
}

// The host must never send audio. Structurally it adds no tracks; this is the assertion.
function assertRecvOnly (sdp) {
  for (const m of sdp.split(/^m=/m).slice(1)) {
    if (/a=(sendrecv|sendonly)/.test(m)) throw new Error('refusing to answer with an outgoing media line')
  }
}

// -------------------------------------------------------------------- peering
function newPeer () {
  const p = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' })
  p.onicecandidate = e => e.candidate && signal({ ice: e.candidate })
  p.ondatachannel = e => bindChannel(e.channel)
  p.ontrack = e => {
    // ponytail: track identity by transceiver order, mid 0 mic and mid 1 system.
    // Holds because the agent always creates them in that order and never renegotiates.
    // Swap to an explicit manifest over the data channel if either stops being true.
    attach(e.transceiver.mid === '1' ? 'sys' : 'mic', e.track)

    // The single biggest receive-side latency lever. jitterBufferTarget is in ms
    // and is the shipped rename of playoutDelayHint, which is in seconds.
    try {
      e.receiver.jitterBufferTarget = 0
      if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0
    } catch {}
  }
  return p
}

function bindChannel (channel) {
  dc = channel
  dc.onopen = () => line('cue channel open')
  dc.onclose = () => line('cue channel closed')
}

// ------------------------------------------------------------------ playback
const meters = {}

// A rebuilt peer connection brings new tracks. Drop the old graph or the dead
// primer elements and analysers pile up across reconnects.
function resetPlayback () {
  for (const m of Object.values(meters)) { m.primer.pause(); m.primer.srcObject = null }
  for (const k of Object.keys(meters)) {
    delete meters[k]
    setMeter(k, 0)
    $(`${k}-state`).textContent = 'no signal'
  }
}

function attach (which, track) {
  ctx ||= new AudioContext({ latencyHint: 'interactive' })
  const stream = new MediaStream([track])

  // Chromium will not pull a remote stream that is routed only into Web Audio.
  // This muted element produces no sound and is not optional.
  const primer = Object.assign(new Audio(), { srcObject: stream, muted: true, autoplay: true })
  primer.play().catch(() => {})

  const gain = ctx.createGain()
  const analyser = Object.assign(ctx.createAnalyser(), { fftSize: 512 })
  ctx.createMediaStreamSource(stream).connect(gain)
  gain.connect(ctx.destination)
  gain.connect(analyser)

  gain.gain.value = Number($(`${which}-gain`).value)
  $(`${which}-gain`).oninput = e => { gain.gain.value = Number(e.target.value) }
  $(`${which}-state`).textContent = 'live'
  meters[which] = { analyser, buf: new Uint8Array(analyser.fftSize), primer }
}

const setMeter = (which, v) => { $(`${which}-meter`).style.width = `${Math.min(100, v * 140)}%` }

function paint () {
  for (const [which, m] of Object.entries(meters)) {
    m.analyser.getByteTimeDomainData(m.buf)
    let sum = 0
    for (const s of m.buf) sum += ((s - 128) / 128) ** 2
    setMeter(which, Math.sqrt(sum / m.buf.length))
  }
  requestAnimationFrame(paint)
}
requestAnimationFrame(paint)

// Round trip time straight off the selected candidate pair.
setInterval(async () => {
  if (pc?.connectionState !== 'connected') return
  for (const s of await pc.getStats()) {
    const [, r] = s
    if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) {
      $('rtt').textContent = `${Math.round(r.currentRoundTripTime * 1000)} ms rtt`
    }
  }
}, 2000)

// ------------------------------------------------------------------ controls
$('speakers').onclick = async () => {
  ctx ||= new AudioContext({ latencyHint: 'interactive' })
  await ctx.resume()
  $('speakers').textContent = 'Speakers on'
  $('speakers').disabled = true
}

$('newcode').onclick = () => {
  location.hash = ''
  location.reload()
}

$('whisper').onsubmit = e => {
  e.preventDefault()
  const text = $('cue').value.trim()
  if (!text) return
  if (dc?.readyState !== 'open') return line('no cue channel, agent not connected')
  dc.send(text)
  line(text, 'cue')
  $('cue').value = ''
}

connect()
