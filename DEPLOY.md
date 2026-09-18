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

## Path B: the Orbya VPS

This box is shared. `SERVER-SETUP.txt` and `DEVELOPER-DEPLOYMENT-GUIDE.md` are
the authority, and CueLine follows Style A from that guide.

The split is strict. CI builds an image, pushes it to GHCR, then asks the box to
pull and restart. Nothing in this repo is copied onto the server, and no
workflow edits nginx, TLS, UFW, or the compose file. Those are host-owned and
maintained by hand.

```
GitHub push ──► Actions ──► build image ──► GHCR
                                              │
Cloudflare ──► host nginx (TLS) ──► 127.0.0.1:3400 ──► cueline-signal container
```

### What CueLine needs allocated

Ask the host operator for these and have them recorded in `SERVER-SETUP.txt`
section 7.

| Item | Value |
| --- | --- |
| Port | `3400` from the free 3400 to 3499 block |
| Image | `ghcr.io/whynotramaa/cueline-signal` |
| Subdomain | `cueline.orbyatravel.com` |

Do not use the 3300 block even though the registry lists it as free. Something
is already listening on `127.0.0.1:3300` through a docker-proxy, so the registry
and the socket table disagree. `first-deploy.sh` checks the socket table and
refuses to start on an occupied port.

No certificate work is needed. The `orbyatravel.com` certificate is a wildcard,
so a new subdomain needs an nginx block and a DNS record and nothing else.

### 1. First bring-up, run by the operator

```sh
scp deploy/first-deploy.sh root@200.234.32.95:/root/
ssh root@200.234.32.95 'bash /root/first-deploy.sh'
```

The script checks the port, creates `/opt/cueline`, writes `.env.prod` at mode
600, pulls the image, and starts the container. It asks you to place the compose
file by hand, because that file is host-owned:

```sh
mkdir -p /opt/cueline/docker
# paste deploy/docker-compose.prod.yml to:
#   /opt/cueline/docker/docker-compose.prod.yml
```

It touches no server config. It prints the remaining manual steps at the end.

### 2. Install the nginx block, by hand

This is the step most likely to go wrong, so read the file before you copy it.

```sh
mkdir -p /opt/cueline/docker/nginx
# paste deploy/cueline.nginx.conf to:
#   /opt/cueline/docker/nginx/cueline.conf
ln -sf /opt/cueline/docker/nginx/cueline.conf /etc/nginx/sites-enabled/cueline.conf
nginx -t && nginx -s reload
```

**Do not copy the standard Orbya proxy block for this site.** CueLine signals
over a websocket, and that block has no `Upgrade` headers. Without them nginx
answers the upgrade handshake with a plain 200, no room ever pairs, and the host
page sits on "agent offline" with nothing in the logs to explain it. The three
lines that matter:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

The block also raises `proxy_read_timeout` to an hour. A paired room holds its
socket open between cues, and the 60 second default would drop it every minute.

### 3. Add the DNS record, proxied

Add `cueline.orbyatravel.com` in Cloudflare pointing at `200.234.32.95`, set to
**Proxied**, the orange cloud.

It must be proxied. UFW on this box allows ports 80 and 443 only from Cloudflare
ranges, so a grey-cloud record is blackholed and the site is simply unreachable.
SSL mode stays Full (strict), which the wildcard origin certificate satisfies.

Cloudflare proxies websockets on all plans, so signalling passes through
unchanged. Audio never touches Cloudflare. It goes peer to peer, or through TURN
if you add it.

### 4. Verify

```sh
docker compose -p cueline -f /opt/cueline/docker/docker-compose.prod.yml \
  --env-file /opt/cueline/.env.prod ps
curl -s http://127.0.0.1:3400/config.json          # on the box
curl -s https://cueline.orbyatravel.com/config.json # from anywhere
```

A JSON body with an `iceServers` array means the container, nginx, Cloudflare,
and TLS all work.

### 5. Add TURN when a call fails to connect

Skip this until a call stalls in connection state `failed`. Home and cafe
networks connect over STUN alone. Corporate networks usually do not.

```sh
nano /opt/cueline/.env.prod    # TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
cd /opt/cueline && docker compose -p cueline \
  -f docker/docker-compose.prod.yml --env-file .env.prod up -d
```

Prefer a provider that offers `turns:` on port 443. A network that blocks
everything else usually leaves 443 open, and that is the case TURN exists for.

## Add the CI deploy key

CueLine gets its own key. The runbook is explicit that CI keys are per project
and carry the `restrict` prefix, so they cannot open port-forwarding tunnels to
anyone else's database.

### 1. Generate the key pair

Generate it on your laptop, not on the server, so the private half never sits on
the box it unlocks.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/cueline_deploy -N "" -C "cueline-github-actions"
```

`-N ""` gives it no passphrase. A CI key cannot type one.

### 2. Authorise the public half on the server

```sh
ssh root@200.234.32.95
printf 'restrict %s\n' "$(cat)" >> /root/.ssh/authorized_keys
# paste the contents of ~/.ssh/cueline_deploy.pub, then press Ctrl-D
```

The `restrict` prefix is required. It removes pty allocation, agent forwarding,
port forwarding, and X11. The deploy runs `bash -s` over stdin, which needs none
of those.

Confirm the file now holds four keys, the three already documented plus this one:

```sh
ssh-keygen -lf /root/.ssh/authorized_keys
```

Editing `authorized_keys` needs no `systemctl reload ssh`. That is only for
changes under `/etc/ssh/sshd_config.d/`.

### 3. Test it before you trust it

From a second terminal, while your current session stays open:

```sh
ssh -i ~/.ssh/cueline_deploy root@200.234.32.95 'docker ps --format "{{.Names}}"'
```

Run a command rather than logging in interactively. `restrict` blocks the pty,
so a bare `ssh` will look like it failed when the key is in fact fine.

### 4. Add the GitHub secrets

In the repo, go to **Settings, Secrets and variables, Actions**, then add three
repository secrets.

| Secret | Value |
| --- | --- |
| `VPS_HOST` | `200.234.32.95` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | The full contents of `~/.ssh/cueline_deploy`, including the `BEGIN` and `END` lines |

```sh
# copies the private key, headers included
cat ~/.ssh/cueline_deploy
```

### 5. Gate the deploy behind a reviewer

Go to **Settings, Environments**, create one named `production`, and add
yourself under **Required reviewers**.

A push to `main` runs as root on a shared VPS. The reviewer gate means a stolen
push still needs a human click before it reaches the box. The workflow already
declares `environment: production`, so the gate applies the moment you create it.

Turn on 2FA for the GitHub account if it is not on already. It is now the
shortest path to the server.

## What the workflows do

`.github/workflows/deploy.yml` runs on pushes to `main` that touch `server/` or
`Dockerfile`. It checks the files parse, builds the image on a GitHub runner,
pushes it to GHCR tagged with the commit SHA, then connects over SSH to pull and
restart. It fails the build if the container does not answer afterwards, and it
prunes dangling images only, never `-a`, because the host is shared.

`.github/workflows/build-agent.yml` runs on a tag starting with `v`, or from the
**Run workflow** button. It builds the Windows installer on a Windows runner and
attaches it to a release on a tag.

```sh
git tag v1.0.0 && git push --tags
```

## Roll back a bad deploy

Images are tagged by commit SHA.

```sh
cd /opt/cueline
export IMAGE_TAG=<previous-good-sha>
docker compose -p cueline -f docker/docker-compose.prod.yml --env-file .env.prod up -d
```

## Verify it end to end

Work down this list. Each line proves the one above it was fine.

1. `curl -s https://cueline.orbyatravel.com/config.json` returns an `iceServers`
   array.
2. The host page shows a six character room code. If the code stays `------` the
   websocket never upgraded, which points at the nginx block from step 2.
3. The agent connects and the presence dot on the host turns green.
4. The tray icon on device A changes from grey to green.
5. A cue typed on device B appears on the agent's overlay within a blink.
6. Both meters move independently when you talk and when you play music.
7. `chrome://webrtc-internals` on device B shows `currentRoundTripTime` and
   `jitterBufferDelay`. Trust these over any estimate in the README.
8. Turn off Wi-Fi on device A for ten seconds. Audio resumes without a new code.
