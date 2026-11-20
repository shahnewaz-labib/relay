# Relay

**Turn localhost into a public URL.**

```sh
relay 3000
# → https://tunnel-9fa21c4b7e03.tnnnnnnnl.xyz
```

An open-source alternative to ngrok. Use the hosted relay with no setup, or
run your own on your own domain. The tunnel protocol,
the stream multiplexer and the HTTP forwarding are all written here — about
2,200 lines of Go, plus 1,000 of JavaScript for the Cloudflare backend.

To self-host, pick a backend. Same client and same protocol:

| Backend | Needs | Good for |
| --- | --- | --- |
| [**Cloudflare**](docs/cloudflare.md) | a domain on Cloudflare | no server to run; free plan |
| [**VPS**](docs/vps.md) | a VPS and a domain | full control; no third party |

## Install

```sh
curl -fsSL https://relay.tnnnnnnnl.xyz/install | sh
```

The script picks the build for your OS and CPU, checks its checksum, and
installs to `/usr/local/bin` (or `~/.local/bin`). Pin a version with
`RELAY_VERSION=v0.1.0`. On Windows, or to skip the script, download an archive
from [Releases](https://github.com/shahnewaz-labib/relay/releases). With Go:

```sh
go install github.com/shahnewaz-labib/relay/cmd/relay@latest
```

## Quick start

```sh
relay 3000
```

That's it. With no setup, relay uses the hosted relay at
`relay.tnnnnnnnl.xyz`. It's shared and free, so it has limits:

- random URL, new on every run
- tunnels end after 2 hours
- 2 tunnels per IP address, 8 on the whole relay
- browser visitors see a one-time "this is a tunnel" page

### Your own server

For stable names and no limits, set up a server once with one of the guides
above. Then:

```sh
relay setup --server https://relay.example.com   # once, paste the token
relay 3000                                       # every time
```

Reuse a name to keep a stable URL:

```sh
relay 3000 --name demo   # → https://demo.example.com
relay 3000 --name demo --json
```

## How it works

```
                      ┌───────── your server ─────────┐
  visitor ──HTTPS──►  │  routes by Host to a tunnel   │
                      └───────────────┬───────────────┘
                                      │ ONE outbound connection,
                                      │ multiplexed, opened by the client
                      ┌───────────────┴───────────────┐
                      │  relay  ──►  localhost:3000   │
                      └───────────────────────────────┘
```

The machine behind NAT never listens. It dials *out* once, and every inbound
visitor byte travels back inside that connection — which stateful firewalls
already permit as reply traffic. One connection carries every visitor
concurrently, as virtual streams.

HTTP, WebSockets and streaming responses all pass through, so dev-server hot
reload works.

## Documentation

| Guide | Contents |
| --- | --- |
| [docs/cloudflare.md](docs/cloudflare.md) | Workers + Durable Objects backend, free-plan budget, CI/CD |
| [docs/vps.md](docs/vps.md) | VPS install, automatic HTTPS, systemd |
| [docs/reference.md](docs/reference.md) | All flags, domain-free modes, raw TCP mode, security model |
| [docs/protocol.md](docs/protocol.md) | Wire protocol, for another implementation |

## Development

Requires Go 1.22 or newer.

```sh
go build -o relay ./cmd/relay
go build -o relayd ./cmd/relayd
go test ./...

cd cloudflare && npm ci && npm test   # Worker backend
```

To release, push a tag: `git tag v0.1.0 && git push origin v0.1.0`.
GoReleaser builds the client for macOS, Linux and Windows and attaches the
archives to a GitHub release. Try it locally with
`goreleaser release --snapshot --clean`.

## Limitations

- **One shared token** for self-hosted servers. No per-client tokens or
  quotas. Only anonymous tunnels are rate-limited.
- **No flow control.** Per-stream receive buffers are unbounded, so a stalled
  consumer grows memory.
- **No stream deadlines.** A wedged origin ties up a goroutine per request.
- **Cloudflare backend buffers request bodies**, with a 25 MB cap.
- **Concurrent large bodies can truncate on the VPS backend.** The covering
  test is skipped; run it with `RELAY_FLAKY=1 go test ./cmd/relayd/`. The
  Cloudflare backend passes the same workload.
