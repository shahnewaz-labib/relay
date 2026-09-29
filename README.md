# Relay

**Turn localhost into a public URL.**

Relay is a personal tunneling project inspired by Cloudflare Quick Tunnels
and ngrok. Run your own server on a VPS, connect the client once, then share
local apps through your domain:

```sh
relay 3000
# → https://tunnel-<random>.tunnels.example.com
```

## VPS first, optional Cloudflare infrastructure later

The supported backend is **your VPS + your domain**, with a native Go binary,
automatic Let's Encrypt HTTPS, and a systemd service. Use any DNS provider.
Relay implements its own tunnel protocol and forwarding; it does not wrap
Cloudflare Tunnel or another hosted tunneling service.

```text
Visitor → HTTPS → relayd on your VPS
                      ↕ WSS on port 443 (opened by the client)
                 relay on your laptop → localhost:3000
```

A second backend using **Cloudflare Workers + Durable Objects** is planned,
targeting the free tier with hibernating connections. The VPS backend will
remain independently usable. Client configuration selects a server origin,
not a provider. See the [protocol contract and remaining backend work](docs/protocol.md).

## VPS quick start

Point `tunnels.example.com` and `*.tunnels.example.com` at your VPS and allow
TCP 80/443. Build the binaries, then run the server:

```sh
relayd --domain tunnels.example.com --https --email you@example.com
```

On your laptop, enroll once using the token from the server:

```sh
relay setup --server https://tunnels.example.com
```

With a local app running:

```sh
relay 3000
relay 3000 --name demo
relay 3000 --name demo --json
```

**[Full VPS installation and systemd guide →](docs/vps.md)**

The first connection to a new name issues a certificate. Reuse `--name demo`
for repeat sessions to reuse its certificate. Public URLs are unauthenticated;
the server token controls which clients can create tunnels.

## Lower-level TCP mode

Expose a service from a machine **without a public IP** by dialing *out* to
`relayd` on a public server.

```
                    ┌────────────────────────── VPS ──────────────────────────┐
                    │  relayd                                                 │
visitor ──HTTPS──►  │  :443/:8080 ── Host routing ──► stream over tunnel conn │
visitor ──HTTP───►  │  :8081/:8082… ── port-map / dynamic ports               │
                    │                                    ▲                    │
                    └────────────────────────────────────┼────────────────────┘
                                                         │ outbound TLS (or TCP),
                                                         │ ONE connection, muxed;
                    ┌────────────────────────────────────┼────────────────────┐
                    │  relay (laptop, no public IP)      │ inbound traffic    │
                    │  ◄── streams ──► localhost:8000    │ rides as "replies" │
                    └─────────────────────────────────────────────────────────┘
```

The founding trick: the laptop never listens. It dials *out* once; every
"inbound" visitor byte travels inside that established connection — which
stateful firewalls already permit as reply traffic.

## Components

| Binary   | Runs on            | Role                                                          |
|----------|--------------------|---------------------------------------------------------------|
| `relayd` | VPS / public host  | Speaks HTTP(S) to visitors; routes each Host to its named tunnel |
| `relay`  | laptop / homelab   | Dials out, authenticates under a name, serves streams         |

## Build and manual setup

Requires Go 1.22 or newer. Clone and build:

```sh
git clone https://github.com/shahnewaz-labib/relay.git
cd relay
go build -o relay ./cmd/relay
go build -o relayd ./cmd/relayd
```

Run the binaries as `./relay` and `./relayd`, or put them on your `PATH` to
use the commands below.

`relayd` generates and stores a token on first run and
prints the exact client command to paste:

```sh
# VPS:
go build -o /usr/local/bin/relayd ./cmd/relayd   # or cross-compile, see below
relayd --port-map me=8081
# ↳ detects its public IP, then prints:
#   relay --relay=DETECTED_IP:7000 --token=9dbf7bc0… --name=me --local=localhost:<port>
#       -> visitors open http://DETECTED_IP:8081
#   (replace <port> with wherever your service listens)

# Laptop (paste, then fill in name + local service):
relay --relay=DETECTED_IP:7000 --token=9dbf7bc0… --name=me --local=localhost:8000
# ↳ prints:
#   Visitors can open:
#       http://YOUR_VPS_IP:8081

# Visitor:
curl http://YOUR_VPS_IP:8081          # served by the laptop
```

The token lives in `~/.relayd/token` (mode 0600) and survives restarts on both
sides. Prefer explicit control? Pass `--auth-token <secret>` instead and it
is used verbatim (and never echoed into logs).

Everything on one machine first:

```sh
python3 -m http.server 8000 &                          # any local service
go run ./cmd/relayd --port-map me=8081 &              # relay; token auto-generated
go run ./cmd/relay --token "$(cat ~/.relayd/token)" \
                 --name me --local localhost:8000      # client
curl http://localhost:8081                             # through the tunnel
```

For real use, run `relayd` on a VPS with a public IP and point a wildcard DNS
record at it (`*.example.com A YOUR_VPS_IP`, proxied through Cloudflare if you like):

```sh
GOOS=linux GOARCH=amd64 go build -o /tmp/relayd ./cmd/relayd
scp /tmp/relayd vps:
ssh vps 'sudo ufw allow 7000/tcp,8080/tcp && nohup ./relayd \
  --auth-token=LONG_RANDOM --domain=example.com > relayd.log 2>&1 &'
go run ./cmd/relay --relay=YOUR_VPS_IP:7000 --token=LONG_RANDOM --name me
# http://me.example.com is now served by your laptop, from anywhere
```

## No domain? Three ways

**One service — catch-all.** Route everything that hits the VPS to a single
tunnel, whatever Host header arrives:

```sh
relayd --auth-token $TOKEN --default home --public-addr=:80
relay  --token $TOKEN --name home --relay=VPS_IP:7000
# → http://VPS_IP/
```

**Several services — one port per tunnel.** Map ports to tunnel names; each
port serves exactly its tunnel regardless of Host:

```sh
relayd --auth-token $TOKEN --port-map "laptop=8081,jellyfin=8082"
relay  --token $TOKEN --name laptop   --relay=VPS_IP:7000 --local localhost:3000
relay  --token $TOKEN --name jellyfin --relay=VPS_IP:7000 --local localhost:8096
# → http://VPS_IP:8081  and  http://VPS_IP:8082
```

**No domain at all — dynamic ports.** Run the relay once with a range; every
new tunnel name that connects gets the next free port automatically, and its
client prints the URL. Assignments persist in `~/.relayd/ports.json`, so
restarts never shuffle anyone's address:

```sh
relayd --port-range "20000-21000"
relay  --relay=VPS_IP:7000 --token=… --name laptop   --local localhost:3000
# client prints: Visitors can open: http://VPS_IP:20000
relay  --relay=VPS_IP:7000 --token=… --name media     --local localhost:8096
# client prints: Visitors can open: http://VPS_IP:20001
```

Open the whole range once in the firewall (`ufw allow 20000:21000/tcp`) —
**or** let the relay manage it: start relayd with `--manage-firewall` plus this
one-time sudoers rule (`sudo visudo -f /etc/sudoers.d/relay`):

```
YOUR_VPS_USER ALL=(root) NOPASSWD: /usr/sbin/ufw allow *, /usr/sbin/ufw delete allow *
```

Then each dynamic port is opened when its tunnel connects and closed when it
goes offline — nothing stays exposed that isn't serving. The wildcard is safe
here because relayd only ever passes integer ports it generated itself; if you
prefer zero wildcards, skip the flag and pin exact ports with `--port-map`.
A mapped port whose client is offline answers 503 until it reconnects.
`--port-map` pins specific name→port pairs that survive even alongside the
dynamic range.

## Flags

**relayd**

- `--auth-token` — shared secret clients must present; empty = load from
  `~/.relayd/token` or generate one there automatically
- `--advertise` — hostname/IP shown to clients; defaults to `--domain`, or
  detects the public IP via ipify/ifconfig.me/icanhazip in domain-free mode
- `--public-addr` — listen address for visitors (default `:8080`)
- `--tunnel-addr` — listen address for tunnel clients (default `:7000`)
- `--domain` — root domain for `<name>.<domain>` routing; empty = exact-Host mode
- `--default` — catch-all tunnel for unmatched Hosts (IP-only deployments)
- `--port-map` — pinned per-tunnel ports, e.g. `"alice=8081,bob=8082"`
- `--port-range` — dynamic pool, e.g. `"20000-21000"`: new tunnel names get
  the next free port automatically (persisted in `~/.relayd/ports.json`)
- `--manage-firewall` — open/close UFW rules for dynamic ports as tunnels
  connect/disconnect (requires the sudoers rule from "No domain" section)
- `--tunnel-cert`, `--tunnel-key` — TLS for the tunnel port
- `--public-cert`, `--public-key` — HTTPS for the public port
- `--https` — automatic Let's Encrypt HTTPS on port 443; requires `--domain`,
  accepts ACME terms, and disables the raw TCP listener unless explicitly set
- `--email` — email for the ACME account
- `--cert-dir` — persistent certificate cache (default `~/.relayd/certs`)
- `--public-url` — external origin when behind a TLS reverse proxy; hostname
  must match `--domain`

**relay**

- `relay setup --server <origin>` — verify and save server credentials once
- `relay <port>` — expose localhost using the saved server
- `--server` — override the saved HTTP(S) server; an override to a different
  server requires its own token
- `--json` — machine-readable ready event on stdout (logs go to stderr)
- `--relay` — address of `relayd`'s tunnel port (default `localhost:7000`)
- `--local` — local service to expose (default `localhost:8000`)
- `--token` — auth token override (otherwise `RELAY_TOKEN` or saved configuration)
- `--name` — tunnel name (default: random for WebSocket connections;
  sanitized machine hostname for raw TCP)
- `--retry-wait` — base pause between relay dial attempts (default `2s`,
  doubles with jitter up to 30s, resets on successful auth)
- `--tls` — dial the relay over TLS
- `--ca` — CA bundle (PEM) to verify the relay's cert; empty = system roots
- `--tls-name` — server name override when verifying the relay's cert

## How it works

1. **Dial out.** The machine behind NAT makes ordinary *outbound* TCP
   connections to the relay. Firewalls allow this by default; replies to an
   established connection may flow both ways. That is the whole trick — the
   "inbound" direction rides inside connections the private side created.
2. **Authenticate & register.** The first frame on a tunnel connection is
   `Auth{name, token}`; the relay answers `AuthAck{url, domain, host, port,
   scheme}` — everything the client needs to print its visitor URL — and
   maps `<name>` (or `<name>.<domain>`, or a dynamically assigned port)
   to that connection.
3. **Multiplex.** One tunnel connection carries every visitor concurrently.
   `internal/wire` frames each virtual stream as
   `[type:1][streamID:8][length:4][payload]` — the same idea as HTTP/2 or
   QUIC streams, at toy scale.
4. **Route HTTP.** Visitors hit the relay's public port speaking real HTTP.
   The relay picks the tunnel by Host header and reverse-proxies each request
   over a fresh stream (`httputil.ReverseProxy` with a stream-dialing
   Transport). Unknown hosts get a 404 page; dead origins get a 502.

## Wire protocol

One multiplexed connection per client, framed as:

```
[type: 1 byte][stream ID: 8 bytes BE][payload length: 4 bytes BE][payload]
```

| Type      | Meaning                                                        |
|-----------|----------------------------------------------------------------|
| `Syn`     | open stream (relay is the only opener today)                   |
| `Data`    | payload for a stream                                           |
| `Fin`     | sender finished with a stream                                  |
| `Ping`/`Pong` | keepalive; replies are sent async so the read loop never blocks on writes |
| `Auth`    | first frame from a client: JSON `{name, token}`                |
| `AuthAck` | relay accepts: JSON `{url, domain, host, port, scheme}`        |
| `Reject`  | refusal (JSON or text reason); the client exits rather than retries |

Request path for one visitor request: DNS → relay :443 → Host lookup →
`httputil.ReverseProxy` dials a fresh stream over the tunnel conn → client
binds it to `localhost:8000` → response streams back through the same stream.

## Running for real

For the domain-first HTTPS setup, use [deploy/relayd.service](deploy/relayd.service)
and the [VPS guide](docs/vps.md). The following is a manual-certificate,
dynamic-port example:

```ini
# /etc/systemd/system/relayd.service  (on the VPS)
[Unit]
Description=relay tunnel server
After=network-online.target

[Service]
# No --auth-token: it loads ~/.relayd/token of User= below, generating it on
# first boot. Add --domain/--port-map/--port-range/--manage-firewall to taste.
ExecStart=/usr/local/bin/relayd --port-range 20000-21000 \
  --tunnel-cert=/etc/relay/tls.pem --tunnel-key=/etc/relay/tls.key \
  --public-cert=/etc/relay/tls.pem --public-key=/etc/relay/tls.key
Restart=always
User=relay
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

The client side wants the same treatment (`Restart=always`, `--tls --ca`).

## Security model

- **Recommended WSS mode:** `--https` manages certificates on the VPS and
  `relay setup --server https://...` verifies them using system roots. Tokens
  are stored in the client configuration with mode 0600.
- **Legacy TCP tunnel leg** (`relay` ↔ `relayd`): enable TLS with `--tunnel-cert/--tunnel-key`
  on the relay and `--tls` (+ `--ca ca.pem` for a private CA) on the client.
  Without it, traffic is plaintext — fine for localhost testing only.
- **Public leg** (visitor ↔ `relayd`): serve HTTPS directly with
  `--public-cert/--public-key`, or front `relayd` with Caddy/nginx doing ACME.
- **Authentication**: every tunnel connection must present the shared token
  as its first frame; bad tokens are rejected before any traffic flows.
- The relay persists its token to `~/.relayd/token` (mode 0600) so restarts
  don't invalidate clients. Delete the file to rotate; clients re-enroll with
  the new printed command.
- Tokens are shared secrets; per-client tokens and rate limits are future work.

## Status / known limitations (by design)

- Named tunnels, Host routing, auth tokens (zero-config enrollment), dynamic
  port ranges, firewall lifecycle management, keepalives + auto-reconnect,
  TLS: done
- Per-stream receive buffers are unbounded (no windowed flow control yet);
  a stalled consumer can grow memory
- Streams ignore deadlines; a wedged origin ties up one goroutine per request

## Roadmap

### Next: optional Cloudflare backend

- [ ] Worker routing for tunnel subdomains on your own domain
- [ ] SQLite-backed Durable Object per tunnel, using WebSocket hibernation
- [x] Encrypted WebSocket transport in the Go client
- [ ] Streaming requests and responses with backpressure and cancellation
- [x] WebSocket forwarding for development-server hot reload (VPS integration tested)
- [x] `relay <port>` with generated names and saved connection settings
- [x] DNS/TLS reachability check and structured JSON output
- [ ] Worker-compatible HTTP bridge or versioned HTTP-aware protocol
- [ ] One-command Workers/DO deployment setup
- [ ] Measure free-tier usage with real development traffic

### Completed: self-hosted Go backend

- [x] Automatic HTTPS and native systemd deployment
- [x] Authenticated WebSocket connections on the visitor HTTPS port
- [x] Frame-based multiplexing: many visitors share one tunnel connection
- [x] Named tunnels + Host-based routing (`me.example.com` → my laptop)
- [x] Auth tokens so only your client can park tunnels
- [x] Keepalives + automatic reconnection with exponential backoff
- [x] TLS on tunnel and public ports
- [x] Dynamic port allocation with restart-stable assignments
- [x] UFW rules that follow the tunnel lifecycle

### Future work (the honest list)

- Windowed per-stream flow control (what yamux/QUIC do) to bound memory and
  stop one slow visitor from buffering unboundedly
- Stream deadlines plumbed end-to-end; request timeouts
- Per-client tokens, quotas, rate limiting
- Raw TCP tunnel mode (`relay --tcp 5432` for Postgres et al.)
- Broader WebSocket conformance testing (basic upgrade/echo is integration tested)
- Graceful drain on shutdown: finish in-flight requests before closing
