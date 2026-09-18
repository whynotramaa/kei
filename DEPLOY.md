# Deploy CueLine

Two devices are required. On one device the host speakers feed back into the
agent's microphone and loopback capture, so you hear yourself twice and the
echo never settles.

- **Device A** runs the agent. Windows, on a headset.
- **Device B** runs the host page in a browser. Any laptop or phone.

Only the host page needs HTTPS. Chromium blocks `RTCPeerConnection` on plain
HTTP origins unless the origin is `localhost`. The agent loads from `file://`,
which Chromium already treats as trustworthy, so the agent never needs a
certificate.

Pick path A to get two devices talking in about ten minutes. Pick path B for
anything you intend to keep.

## Path A: LAN test, no domain

Use this to prove the audio and the cues work before you rent a server.

1. Start the server on any machine on your network. That machine can be your
   Arch box.

   ```sh
   cd server && npm install && npm start
   ```

2. Find that machine's LAN address.

   ```sh
   ip -4 addr show | grep -oP '(?<=inet\s)192\.168\.\d+\.\d+'
   ```

3. Open the firewall for port 8080 if the machine runs one.

   ```sh
   sudo ufw allow 8080/tcp
   ```

4. On device B, open Chrome and go to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
   Add `http://192.168.x.x:8080` with your address, set the flag to Enabled, and
   restart the browser. Without this step the page loads and the room code
   appears, but the call never starts.

5. On device B, open `http://192.168.x.x:8080` and read the room code.

6. On device A, copy the `client` folder across, then run it.

   ```sh
   cd client && npm install && npm start
   ```

   Enter `http://192.168.x.x:8080` and the room code, then click **Connect**.

7. On device B, click **Enable speakers**. Browsers block audio until a click.

Both meters should move when you speak into the headset on device A or play
music there. Type in the cue box on device B and the cue appears on device A.

STUN is not involved on a LAN, so this path tells you nothing about whether the
call survives a real network. Path B does.

## Path B: Hostinger VPS behind nginx and Cloudflare

Your box already runs nginx 1.24 on ports 80 and 443, with Cloudflare in front
and `algoeve.conf` and `resqnet.conf` enabled. CueLine adds one more nginx site
and one systemd service. It does not touch the existing ones.

Port 8080 is free on that box. Ports 3100 to 3104, 3200, 3300, 9100, 9101, and
5435 are taken, so do not reuse those.

The signalling service runs under its own `cueline` user, binds to `127.0.0.1`
only, and is reachable from outside through nginx alone.

### 1. Point a subdomain at the box

In the Cloudflare dashboard, add an A record for `cueline.yourdomain.com` that
points at the VPS IP.

Leave the proxy off, the grey cloud, until step 4 finishes. The certificate
request in step 3 is simpler when Let's Encrypt reaches the origin directly.

```sh
dig +short cueline.yourdomain.com
```

### 2. Clone the repo onto the server

```sh
ssh root@your-box
apt-get update && apt-get install -y git rsync
git clone git@github.com:whynotramaa/kei.git /opt/cueline
```

Clone to `/opt/cueline` exactly. The deploy script and the CI workflow both
expect that path.

### 3. Run the first deployment

```sh
cd /opt/cueline
./deploy/deploy.sh cueline.yourdomain.com --certbot
```

The script installs Node 22 if the box does not have it, creates the `cueline`
system user, installs dependencies, writes `/etc/cueline.env`, installs and
starts the systemd unit, adds the nginx site, and requests a certificate.

It refuses to run if port 8080 is already taken, and it keeps an existing
`/etc/cueline.env` so a second run does not wipe your TURN credentials.

Drop `--certbot` if you would rather let Cloudflare terminate TLS with SSL mode
set to Flexible. The host page only needs HTTPS in the browser, so either works.

### 4. Turn the Cloudflare proxy back on

Switch the record to proxied, the orange cloud, and set SSL mode to **Full
(strict)** if you used `--certbot`, or **Flexible** if you did not.

Cloudflare proxies WebSockets, so signalling passes through unchanged. The audio
never touches Cloudflare. It goes peer to peer, or through TURN if you add it.

### 5. Verify

```sh
systemctl status cueline
journalctl -u cueline -f
curl -s http://127.0.0.1:8080/config.json          # on the box
curl -s https://cueline.yourdomain.com/config.json # from anywhere
```

A JSON body with an `iceServers` array means the service, nginx, and TLS all
work.

### 6. Run the agent on Windows

Download the installer from the repo's Releases page, or copy the `client`
folder to device A and run it from source:

```powershell
cd client
npm install
npm start
```

Enter `https://cueline.yourdomain.com` and the room code from the host page.

### 7. Add TURN when a call fails to connect

Skip this until you see a call stall in connection state `failed`. Home and cafe
networks connect over STUN alone. Corporate networks usually do not.

```sh
nano /etc/cueline.env      # fill in TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
systemctl restart cueline
```

Prefer a provider that offers `turns:` on port 443. A network that blocks
everything else usually leaves 443 open, and that is the case TURN exists for.

## Continuous deployment

After the first deployment, pushes to `main` deploy themselves.

### Create a deploy key

On the server:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/cueline_deploy -N "" -C "github-actions"
cat ~/.ssh/cueline_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/cueline_deploy          # copy this private key
```

### Add the repository secrets

Go to **Settings, Secrets and variables, Actions** in the GitHub repo and add
three secrets.

| Secret | Value |
| --- | --- |
| `SSH_HOST` | The VPS IP address |
| `SSH_USER` | `root` |
| `SSH_KEY` | The private key printed above, including both header lines |

### What the workflows do

`.github/workflows/deploy-server.yml` runs on any push to `main` that touches
`server/` or `deploy/`. It checks that the files parse, connects over SSH, resets
`/opt/cueline` to `origin/main`, installs dependencies, restarts the service, and
fails the build if the service does not answer afterwards.

`.github/workflows/build-agent.yml` runs on any push that touches `client/`. It
builds the Windows installer on a Windows runner and uploads it as an artifact.
Pushing a tag that starts with `v` publishes a release with the installer
attached.

```sh
git tag v1.0.0 && git push --tags
```

The build is unsigned, so SmartScreen warns on first run. Code signing needs a
purchased OV or EV certificate.

## Verify it end to end

Work down this list. Each line proves the one above it was fine.

1. `curl -s https://yourdomain/config.json` returns an `iceServers` array.
2. The host page shows a six character room code.
3. The agent connects and the presence dot on the host turns green.
4. The tray icon on device A changes from grey to green.
5. A cue typed on device B appears on the agent's overlay within a blink.
6. Both meters move independently when you talk and when you play music.
7. `chrome://webrtc-internals` on device B shows `currentRoundTripTime` and
   `jitterBufferDelay`. Trust these numbers over any estimate in the README.
8. Turn off Wi-Fi on device A for ten seconds. Audio should resume without a new
   room code.

## Update a running deployment

Push to `main`. The workflow does the rest.

To deploy by hand, or to check what the workflow would do:

```sh
ssh root@your-box 'cd /opt/cueline && git pull && cd server && npm ci --omit=dev && systemctl restart cueline'
```
