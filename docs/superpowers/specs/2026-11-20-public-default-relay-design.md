# Public default relay: design

## Intent

Install relay, run `relay 3000`, get a public URL. No server, no setup, no
token. By default the client uses the maintainer's hosted relay on
`tnnnnnnnl.xyz`. People who want their own server can still self-host, the same
way as today.

## Goals

- `relay 3000` works on first run with no config.
- Strangers cannot hijack each other's tunnels.
- The hosted relay stays inside the Workers free plan.
- Self-hosting and token-based use keep working unchanged.

## Non-goals

- Accounts, login, per-user tokens (possible later: "option C").
- Custom names for anonymous users.
- Anonymous mode on the VPS backend (`relayd`).
- Strong abuse resistance against someone using many IPs.

## Anti-goals

- Making the domain an easy phishing host: no chosen names, plus a warning
  page for visitors.
- One user filling the free-plan budget for everyone.

## Approaches considered

| Approach | Trade-off |
| --- | --- |
| **A. Fully anonymous** (picked) | Zero setup. Abuse can be limited, not banned. |
| B. Sign in on first run | Per-user bans and limits. First run is no longer one command. Needs OAuth and a user store. |
| C. Anonymous, sign in for custom names | Best of both, but more work. Can be added on top of A later without changing commands. |

Picked A, to match "one command" exactly. C remains the upgrade path.

## Flow

```
relay 3000
  │ no saved config, no --server
  ▼
client: server = https://relay.tnnnnnnnl.xyz, key = 32 random bytes (per run)
  │ WebSocket /_relay/connect, no Authorization header
  │ Auth{ key }
  ▼
Worker (ANONYMOUS on): name = "tunnel-" + first 12 hex of sha256(key)
  │ checks: per-IP cap, global cap; starts 2h lifetime
  ▼
AuthAck{ url: https://tunnel-xxxxxxxxxxxx.tnnnnnnnl.xyz }
  │
  ▼
visitor (browser) → one-time warning page → cookie → proxied to localhost
```

## Decisions

### Client (`cmd/relay`)

- Default server `https://relay.tnnnnnnnl.xyz` when no `--server`, no saved
  config and no `--relay`. Saved config or `--server` always wins.
- With no token for the server in use, run anonymous: generate a 32-byte key
  once per process, send `Auth{key}` with no token and no Authorization
  header. Reconnects in the same process reuse the key, so the URL is stable
  for the run.
- `--name` without a token: exit before dialing with
  "custom names need your own server or a token: <docs link>".
- `Reject` is already fatal. Print the server's reason as-is ("server full",
  "tunnel expired", ...).
- The URL comes from AuthAck, so the client no longer assumes the name it sent.

### Protocol

- `Auth` gains optional `key` (string, hex). Unknown fields are ignored by
  the existing Go server and the Worker, so old servers stay compatible.
- Anonymous auth = `key` present, `token` empty. `name` is ignored.
- Update `docs/protocol.md`.

### Worker (`cloudflare/`)

- New var `ANONYMOUS` ("1" to enable). Off by default, so self-hosted Workers
  behave as before.
- With `ANONYMOUS`, `/_relay/connect` and `/_relay/check` accept requests
  without the Authorization header. A present but wrong token is still 401.
- Name = `tunnel-` + first 12 hex chars of sha256(key). Only the key holder
  can produce it, so displacement ("newest wins") stays safe: reconnecting
  with the same key is the owner.
- Token holders keep full behavior, including any name.
- Limits, all anonymous-only, all set by vars:
  - `ANON_MAX_TUNNELS` default 8 (whole relay). Reject: "server full, try
    later or self-host: <link>".
  - `ANON_MAX_PER_IP` default 2, keyed on `CF-Connecting-IP`, stored in the
    socket attachment.
  - `ANON_MAX_SECONDS` default 7200. Checked on each keepalive (every 10s
    already wakes the object). Reject: "tunnel expired after 2h".
  - A reconnect with the same key replaces its old socket, so it does not
    count twice against the caps.
- Warning page on anonymous tunnels:
  - Shown for `GET` with `Accept` containing `text/html` and no
    `relay_ok` cookie for that host.
  - Says: this is a tunnel to someone's computer, not run by the domain
    owner; don't enter passwords. One "Continue" button sets the cookie
    (host-only, 1 day) and redirects back.
  - Skipped for WebSocket upgrades and non-HTML requests (APIs, assets).
- Production `wrangler.jsonc` sets `ANONYMOUS: "1"`.

### Docs

- README quick start leads with `relay 3000`. Self-hosting moves to second.
- `docs/cloudflare.md`: the new vars, and the free-plan sizing behind 8.

## Constraints

- Workers free plan: 100k requests/day; each idle tunnel ~8,600/day on
  keepalives. 8 tunnels ≈ 69k, leaving room for visitor traffic.
- Tunnels must be one level under the zone apex (Universal SSL).
- Everything runs in the single `TunnelHub` object, so global counting is a
  simple scan of `getWebSockets()`.

## Left to the builder

- Exact wording and styling of the warning page and error messages
  (reuse `errorPage` style).
- Test layout. Worker logic gets unit tests where it can be pulled out of
  the object; Go client gets tests for default-server and anonymous
  selection.

## Known risks

- Someone with many IPs can fill the 8 slots. Mitigation later: login (C)
  or the paid plan.
- The cookie skips the warning page per host, so a phishing visitor still
  sees it once. That is the intent.
