# VPS + domain

Relay runs its own tunnel server. This deployment needs no Cloudflare account,
Cloudflare proxy, or Cloudflare Tunnel. Use any VPS and DNS provider.

## 1. Point your domain at the VPS

For the examples below, the base domain is `tunnels.example.com`:

| Record | Type | Value |
| --- | --- | --- |
| `tunnels.example.com` | A | your VPS IPv4 address |
| `*.tunnels.example.com` | A | your VPS IPv4 address |

If you publish AAAA records, IPv6 must also reach this server. If your DNS
provider offers a proxy, use DNS-only records for this setup.

Allow inbound TCP **80 and 443** in the VPS provider firewall and the host
firewall. The laptop only makes outbound connections on 443. Port 80 serves
ACME validation and HTTPS redirects; both visitors and tunnel clients use 443.

## 2. Build the binaries

Requires Go 1.22 or newer. From the repository:

```sh
# Client, for your current machine:
go build -o relay ./cmd/relay

# Server, for a Linux x86-64 VPS (use GOARCH=arm64 for an ARM VPS):
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o relayd ./cmd/relayd
scp relayd user@YOUR_VPS:/tmp/relayd
```

Put the client on your PATH, or use `./relay` in the commands below.

## 3. Install the server with systemd

Copy `deploy/relayd.service` to the VPS. Edit its `ExecStart` to set your base
domain and email. On a fresh Debian/Ubuntu VPS:

```sh
sudo useradd --system --user-group --home-dir /var/lib/relay --shell /usr/sbin/nologin relay
sudo install -m 0755 /tmp/relayd /usr/local/bin/relayd
sudo install -m 0644 relayd.service /etc/systemd/system/relayd.service
sudo systemctl daemon-reload
sudo systemctl enable --now relayd
sudo journalctl -u relayd -f
```

The service runs:

```sh
relayd --domain tunnels.example.com --https --email you@example.com
```

`--https` enables automatic Let's Encrypt certificates and renewal, accepts
the ACME terms, and disables the legacy raw-TCP listener unless explicitly
requested. The server generates a token on first boot. Read it on the VPS:

```sh
sudo cat /var/lib/relay/.relayd/token
```

Keep `/var/lib/relay` persistent: it contains the token and certificate cache.
Certificates are issued for the base hostname and individual connected tunnel
hostnames, using HTTP-01 validation. No DNS API token or wildcard certificate
is required. Unknown/unregistered names cannot trigger certificate issuance.

The first connection to a new hostname can take longer while its certificate
is issued. Use `--name demo` for repeated development sessions to reuse its
certificate and avoid consuming Let's Encrypt's new-certificate rate limits.

## 4. Enroll the client once

```sh
relay setup --server https://tunnels.example.com
# Paste the token at the hidden prompt.
```

Setup verifies HTTPS, credentials, and the protocol before saving the server
and token in the OS user configuration directory, under `relay/config.json`
(file mode 0600). Set `RELAY_CONFIG` to override the file path. Run setup again
to switch servers.

## 5. Share an app

With your app already listening on port 3000:

```sh
relay 3000
# https://tunnel-<random>.tunnels.example.com → localhost:3000

relay 3000 --name demo
# https://demo.tunnels.example.com → localhost:3000

relay 3000 --name demo --json
# {"event":"ready","url":"https://demo.tunnels.example.com",...}
```

Relay checks local TCP reachability, authenticates the tunnel, and checks the
public hostname's DNS/TLS reachability before announcing it. This does not
assert that your app's HTTP responses are healthy. Ctrl+C stops the tunnel.
Transient disconnects reconnect under the same name. A name already used by a
live client is rejected. Public URLs are accessible without the connector token.

For a one-off connection without saving configuration:

```sh
RELAY_TOKEN=... relay 3000 --server https://tunnels.example.com --name demo
```

## Local testing

Use a hosts file or local wildcard DNS to resolve both `relay.test` and
`demo.relay.test` to `127.0.0.1`, then run these in separate terminals:

```sh
go run ./cmd/relayd --domain relay.test --public-addr 127.0.0.1:8080 \
  --tunnel-addr= --auth-token dev-token
```

```sh
python3 -m http.server 3000
```

```sh
RELAY_TOKEN=dev-token go run ./cmd/relay 3000 --server http://relay.test:8080 --name demo
```

Visit `http://demo.relay.test:8080`. Local HTTP testing does not request
certificates. Behind an existing TLS reverse proxy, pass
`--public-url https://tunnels.example.com`, bind the HTTP listener to loopback,
and proxy both the base domain and wildcard subdomains with WebSocket support.
