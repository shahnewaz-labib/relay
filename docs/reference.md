# Reference

Every flag, plus the deployment modes that do not need a domain. For the
guided setups see [vps.md](vps.md) and [cloudflare.md](cloudflare.md).

## relayd flags

| Flag | Meaning |
| --- | --- |
| `--auth-token` | Shared secret clients must present. Empty loads `~/.relayd/token`, generating one on first run. |
| `--domain` | Root domain for `<name>.<domain>` routing. Empty means exact-Host matching. |
| `--https` | Automatic Let's Encrypt HTTPS on :443. Requires `--domain`, accepts the ACME terms, and disables the raw TCP listener unless you set one. |
| `--email` | Email for the ACME account. |
| `--cert-dir` | Certificate cache (default `~/.relayd/certs`). |
| `--public-addr` | Listen address for visitors (default `:8080`). |
| `--tunnel-addr` | Listen address for tunnel clients (default `:7000`). |
| `--public-url` | External origin when behind a TLS reverse proxy. Its hostname must equal `--domain`. |
| `--advertise` | Hostname or IP shown to clients. Defaults to `--domain`, else the detected public IP. |
| `--default` | Catch-all tunnel for unmatched Hosts. |
| `--port-map` | Pinned per-tunnel ports, e.g. `"alice=8081,bob=8082"`. |
| `--port-range` | Dynamic pool, e.g. `"20000-21000"`. Assignments persist in `~/.relayd/ports.json`. |
| `--manage-firewall` | Open and close UFW rules as dynamic-port tunnels come and go. |
| `--public-cert`, `--public-key` | Serve HTTPS on the public port from files instead of ACME. |
| `--tunnel-cert`, `--tunnel-key` | TLS on the raw tunnel port. |

## relay flags

| Flag | Meaning |
| --- | --- |
| `relay setup --server <origin>` | Verify and save server credentials once. |
| `relay <port>` | Expose `localhost:<port>` using the saved server. |
| `--name` | Tunnel name. Defaults to a random name, or the machine hostname in raw TCP mode. |
| `--server` | Override the saved server. Pointing at a different server needs that server's own token. |
| `--token` | Token override. Otherwise `RELAY_TOKEN`, then the saved configuration. |
| `--json` | Machine-readable ready event on stdout; logs go to stderr. |
| `--local` | Local service to expose (default `localhost:8000`). |
| `--relay` | Address of relayd's raw tunnel port (default `localhost:7000`). |
| `--retry-wait` | Base pause between dial attempts (default `2s`, doubling with jitter to 30s, reset on successful auth). |
| `--tls` | Dial the raw tunnel port over TLS. |
| `--ca` | CA bundle to verify the relay. Empty uses system roots. |
| `--tls-name` | Server name override for TLS verification. |

`RELAY_CONFIG` overrides the client configuration path.

## Running without a domain

These modes apply to the VPS backend. The Cloudflare backend always needs a
domain.

### One service, catch-all

Every Host that matches nothing goes to a single tunnel.

```sh
relayd --auth-token $TOKEN --default home --public-addr=:80
relay  --token $TOKEN --name home --relay=VPS_IP:7000
# → http://VPS_IP/
```

### Several services, one port each

Each listed port serves exactly its tunnel, whatever Host arrives. A mapped
port whose client is offline answers 503 until it reconnects.

```sh
relayd --auth-token $TOKEN --port-map "laptop=8081,jellyfin=8082"
relay  --token $TOKEN --name laptop   --relay=VPS_IP:7000 --local localhost:3000
relay  --token $TOKEN --name jellyfin --relay=VPS_IP:7000 --local localhost:8096
# → http://VPS_IP:8081 and http://VPS_IP:8082
```

### Dynamic ports

Every new tunnel name gets the next free port, and its client prints the URL.
Assignments persist, so restarts never shuffle anyone's address.

```sh
relayd --port-range "20000-21000"
relay  --relay=VPS_IP:7000 --token=… --name laptop --local localhost:3000
# client prints: Visitors can open: http://VPS_IP:20000
```

Open the range once with `ufw allow 20000:21000/tcp`, or let relayd manage it
with `--manage-firewall` plus one sudoers rule
(`sudo visudo -f /etc/sudoers.d/relay`):

```
YOUR_VPS_USER ALL=(root) NOPASSWD: /usr/sbin/ufw allow *, /usr/sbin/ufw delete allow *
```

Each dynamic port then opens when its tunnel connects and closes when it goes
offline, so nothing stays exposed that is not serving. The wildcard is safe
because relayd only ever passes integer ports it generated itself. For zero
wildcards, skip the flag and pin exact ports with `--port-map`.

## Raw TCP mode

The original transport, before WebSocket. The client dials relayd's
`--tunnel-addr` directly instead of speaking HTTPS to a server origin.

```sh
# VPS
relayd --port-map me=8081
# prints a ready-to-paste client command, including the generated token

# Laptop
relay --relay=VPS_IP:7000 --token=… --name me --local localhost:8000
```

relayd generates a token on first run and stores it in `~/.relayd/token`
(mode 0600), so restarts do not invalidate clients. Delete that file to
rotate. Pass `--auth-token` to supply one yourself; it is never echoed into
logs.

Everything on one machine, to try it:

```sh
python3 -m http.server 8000 &
go run ./cmd/relayd --port-map me=8081 &
go run ./cmd/relay --token "$(cat ~/.relayd/token)" --name me --local localhost:8000
curl http://localhost:8081
```

## Security model

- **Recommended (WSS).** `--https` manages certificates, and
  `relay setup --server https://…` verifies them against system roots. The
  client stores its token at mode 0600.
- **Raw TCP leg.** Enable TLS with `--tunnel-cert`/`--tunnel-key` on the
  server and `--tls` on the client, plus `--ca` for a private CA. Without it
  the leg is plaintext — localhost testing only.
- **Public leg.** Serve HTTPS directly with `--public-cert`/`--public-key`,
  or front relayd with Caddy or nginx.
- **Authentication.** Every tunnel connection presents the token as its first
  frame, and is rejected before any traffic flows if it is wrong. Tokens are
  compared in constant time.
- **Public URLs are unauthenticated.** The token controls who may *create* a
  tunnel, not who may visit one.
- One shared token for all clients. Per-client tokens, quotas and rate limits
  are not implemented.
