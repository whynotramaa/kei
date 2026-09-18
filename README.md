# CueLine

CueLine sends one machine's audio to an operator in a web browser, and sends
the operator's typed cues back to that machine as an on-screen overlay.

Audio travels one way. The desktop agent captures the microphone and the system
output, and the host page plays both. The host never sends audio back, so the
agent's machine stays silent and nothing leaks into a meeting the agent is in.

The agent runs on Windows. The host runs in any Chromium browser, including one
on a phone.

## What you need

- A Linux box running nginx, and a domain that points at it.
- Node 22 or later.
- A TURN provider if the agent sits behind corporate NAT. STUN alone handles
  home and cafe networks.

`RTCPeerConnection` requires a secure context. The host page must run over HTTPS
or on `localhost`. Plain HTTP over a LAN does not work.

## Run the server locally

```sh
cd server
npm install
npm start
```

The server listens on port 8080 and serves three things. It serves the host page
from `server/public`, it serves the ICE configuration at `/config.json`, and it
relays signalling messages at `/ws`. It never sees audio.

Open `http://localhost:8080` and the page shows a six character room code.

## Deploy the server

Test with two devices. On one device the host speakers feed back into the
agent's microphone and loopback capture, and the echo never settles.

The full runbook, both a LAN test with no domain and a VPS behind nginx, is in
[DEPLOY.md](DEPLOY.md). On a box that already runs nginx:

```sh
git clone git@github.com:whynotramaa/kei.git /opt/cueline
cd /opt/cueline
sudo ./deploy/deploy.sh cueline.yourdomain.com --certbot
```

The script installs Node if needed, creates a `cueline` system user, starts a
systemd service bound to `127.0.0.1:8080`, and adds one nginx site that proxies
to it. It leaves existing sites alone and refuses to run if the port is taken.

After that, pushes to `main` deploy themselves through GitHub Actions.

## Run the agent

```sh
cd client
npm install
npm start
```

The agent opens as the overlay itself, not as a separate window. It starts in
setup, where it accepts a server URL and a room code. Once the call connects it
switches to cue mode, becomes click-through, and shows nothing but cues.

Windows asks for microphone access on first run. If you deny it, the agent tells
the host which permission is missing instead of going quiet.

### Shortcuts

These are global, so they work while another app has focus.

| Keys | What it does |
| --- | --- |
| `Ctrl Alt S` | Switch between setup and cue mode |
| `Ctrl Alt H` | Hide or show the overlay |
| `Ctrl Alt [` / `]` | Opacity down or up, in steps of 10 percent |
| `Ctrl Alt PgUp` / `PgDn` | Larger or smaller, 70 to 180 percent |
| `Ctrl Alt` arrows | Move the overlay |
| `Ctrl Alt 0` | Reset position, size, and opacity |

Position, size, and opacity persist across restarts in `overlay.json` under the
app's user data folder. If another app already owns one of these combinations,
the agent logs which ones it could not register.

To build the installer, run `npm run dist`. The build writes an NSIS installer
and a portable executable to `client/dist`.

The build is unsigned, so SmartScreen warns on first run. Code signing needs a
purchased OV or EV certificate.

## Use it

1. Open the host page and read the room code aloud, or send the URL. The code
   lives in the page fragment, so the URL carries it.
2. Connect the agent with that code. The presence dot on the host turns green.
3. Click **Enable speakers** on the host. Browsers block audio until a click,
   so the meters stay flat until you do.
4. Type in the cue box and press Enter. The cue appears on the agent's overlay
   and fades after 12 seconds.

The two faders control the microphone and the system audio separately, so you
can pull down a loud meeting and still hear the agent speak.

## Latency

One way audio lands around 80 to 150 ms on a direct peer to peer path. TURN adds
50 to 200 ms when the network forces a relay.

Four choices in the code account for most of that budget.

The agent asks Opus for 10 ms frames instead of the 20 ms default. The agent
also turns off echo cancellation, noise suppression, and gain control, because
the WebRTC audio pipeline adds roughly 10 to 20 ms of algorithmic delay and a
headset is already required. The host sets `receiver.jitterBufferTarget = 0`,
which is the largest single lever on the receive side. The host plays through a
Web Audio graph rather than an `<audio>` element, which avoids another 80 to
150 ms of buffering.

The agent requests a video track from `getDisplayMedia` and stops it on the next
line. That is not screen sharing and it costs no latency. `getDisplayMedia` is
the only API in Chromium that exposes system loopback audio, and the spec
rejects audio-only calls to it. No video track ever reaches the peer connection.

To measure the real numbers, open `chrome://webrtc-internals` on the host and
watch `jitterBufferDelay` and `currentRoundTripTime`.

## Limits

Read these before you file a bug.

**The agent needs a headset.** Chromium captures the whole system mix, not one
process. On open speakers the microphone records the meeting a second time and
the host hears everything twice. No code fixes this.

**Room codes carry no authentication.** Anyone who guesses a live six character
code joins the room. That is acceptable for short operator sessions and not
acceptable for anything longer.

**Nothing is recorded.** The server relays JSON and never touches audio. Adding
recording changes what this product is and brings a consent problem with it.

**Windows only.** The `audio: 'loopback'` option in
`session.setDisplayMediaRequestHandler` works on Windows and nowhere else.
macOS needs a different capture path.

## If system audio stays silent on Windows

The agent captures loopback through `setDisplayMediaRequestHandler` with
`useSystemPicker: false`, which lets it start without showing a picker.

Electron issue 52738 reports that this combination hands back an audio track
that is already ended and never delivers samples. That report is macOS only,
because it comes from the ScreenCaptureKit capture path. Windows captures
loopback through WASAPI instead and should not hit it.

If the agent reports "loopback track dead on arrival" on Windows, that bug now
affects Windows too. Change `useSystemPicker` to `true` in `client/main.js`. The
agent then shows a picker on connect, which is worse to use but works.

## Layout

| Path | What it holds |
| --- | --- |
| `server/index.js` | Room map, websocket relay, static files, ICE config |
| `server/public/host.js` | Host peer connection, Web Audio playback, meters, cue channel |
| `client/main.js` | The one window, tray, global shortcuts, loopback handler |
| `client/overlay.html` | Setup form, capture, peer connection, cue display |
| `deploy/deploy.sh` | First deployment, safe to re-run |
| `deploy/cueline.service` | systemd unit, runs as its own user |
| `deploy/cueline.nginx.conf` | nginx site with the websocket upgrade headers |
| `.github/workflows/` | Deploy on push, build the Windows installer |
