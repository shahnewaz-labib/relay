# Public Default Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `relay 3000` with no config opens an anonymous, rate-limited tunnel on the hosted relay at `relay.tnnnnnnnl.xyz`.

**Architecture:** The client sends a random per-run key instead of a token. The Worker derives the tunnel name from the key's hash, so only the key holder owns it. Admission caps, expiry and the visitor warning page live in a new pure module, `cloudflare/src/anon.js`, which `TunnelHub` calls. Self-hosted and token use are unchanged.

**Tech Stack:** Go 1.22 client, Cloudflare Worker (plain JS, Durable Objects), `node:test`, `go test`.

**Spec:** `docs/superpowers/specs/2026-11-20-public-default-relay-design.md`

## Global Constraints

- Anonymous mode only when Worker var `ANONYMOUS` is `"1"`. Otherwise behaviour is byte-for-byte today's.
- Key: 32 random bytes, lowercase hex (64 chars). Anything else is rejected with `invalid key`.
- Name: `"tunnel-" + first 12 hex chars of sha256(UTF-8 bytes of the hex key string)`. Vector: key = 64 × `"0"` → `tunnel-60e05bd1b195`.
- Limit vars and defaults: `ANON_MAX_TUNNELS` = 8, `ANON_MAX_PER_IP` = 2, `ANON_MAX_SECONDS` = 7200. Missing or non-positive-integer values fall back to the default.
- Limits and the warning page apply to anonymous tunnels only. Token tunnels are never counted or rejected by them.
- Self-host link in messages: `https://github.com/shahnewaz-labib/relay#readme`.
- Exact reject reasons:
  - `server full, try later or self-host: https://github.com/shahnewaz-labib/relay#readme`
  - `too many tunnels from your IP (max 2)` (number from the limit)
  - `tunnel expired after 2h` (hours = maxSeconds/3600, rounded down, min 1; use `after Ns` when under an hour)
  - `invalid key`
- Default server: `https://relay.tnnnnnnnl.xyz`.
- Commit style: one commit per task, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `gofmt` clean.

## Review Focus

1. **Open redirect** on the warning page's continue link: `to=//evil.com` or `to=https://evil.com` must redirect to `/`. Test in Task 3.
2. **Reconnect while the old socket lingers OPEN** (same key, same IP, at the per-IP cap) must still be admitted, because the old socket gets displaced. Test in Task 2.
3. **Wrong token while `ANONYMOUS` is on** must still get 401 / `bad token`, never fall through to anonymous. Test in Task 2 (`classifyAuth`).
4. **Non-browser visitors** (curl, `fetch` with `Accept: */*`, POST, WebSocket) must never see the warning page. Test in Task 3.
5. **Existing self-host users** with a saved config must keep their server and token. A `--server` flag must win over the default. Test in Task 4.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `internal/protocol/protocol.go` | modify | `Auth.Key`, `NewAnonKey`, `AnonName` |
| `internal/protocol/protocol_test.go` | create | name vector, key format |
| `cloudflare/src/anon.js` | create | pure anonymous logic: name, limits, admission, expiry, warning page |
| `cloudflare/test/anon.test.js` | create | tests for `anon.js` |
| `cloudflare/src/index.js` | modify | wire `anon.js` into `TunnelHub` |
| `cmd/relay/main.go` | modify | default server, anonymous mode, no auth header without token |
| `cmd/relay/config.go` | modify | `pickServer`, `anonymousMode` helpers |
| `cmd/relay/config_test.go` | modify | tests for the helpers |
| `cloudflare/wrangler.jsonc`, `wrangler.dev.jsonc` | modify | `ANONYMOUS: "1"` |
| `docs/protocol.md`, `docs/cloudflare.md`, `README.md` | modify | docs |

---

### Task 1: Protocol: anonymous key and name (Go + JS)

**Files:**
- Modify: `internal/protocol/protocol.go` (the `Auth` struct, near `RandomName`)
- Create: `internal/protocol/protocol_test.go`
- Create: `cloudflare/src/anon.js`
- Create: `cloudflare/test/anon.test.js`
- Modify: `docs/protocol.md` (Auth frame section)

**Interfaces:**
- Produces (Go): `Auth.Key string \`json:"key,omitempty"\``; `func NewAnonKey() (string, error)`; `func AnonName(key string) (string, bool)` (false when the key isn't 64 lowercase hex).
- Produces (JS): `export async function anonName(key: string): Promise<string | null>` (null when invalid). Uses `crypto.subtle.digest("SHA-256", ...)`, which works in Node 24 and Workers.

- [ ] **Step 1: Write failing Go tests** in `protocol_test.go`:
  - `TestAnonNameVector`: `AnonName(strings.Repeat("0", 64))` == `("tunnel-60e05bd1b195", true)`.
  - `TestAnonNameRejectsBadKeys`: `""`, 63 zeros, 64 × `"A"` (uppercase), 64 × `"g"` all return `("", false)`.
  - `TestNewAnonKeyIsValid`: the key is 64 chars, `AnonName` accepts it, two calls differ.
- [ ] **Step 2: Write failing JS tests** in `anon.test.js`:
  - `anonName("0".repeat(64))` resolves to `"tunnel-60e05bd1b195"`.
  - The same four bad keys resolve to `null`.
- [ ] **Step 3: Run** `go test ./internal/protocol/` and `cd cloudflare && npm test`. Expected: both FAIL (undefined symbols / missing module).
- [ ] **Step 4: Implement** the Go functions in `protocol.go` (`crypto/rand` + `crypto/sha256`), and `anonName` in `anon.js`. Use regex `^[0-9a-f]{64}$` in both.
- [ ] **Step 5: Run** both test commands. Expected: PASS.
- [ ] **Step 6: Document** in `docs/protocol.md`: `key` is optional. Key present and token empty means anonymous. `name` is then ignored and derived as above (give the vector). Servers that don't know `key` ignore it.
- [ ] **Step 7: Commit** `feat: anonymous key and derived tunnel name in the protocol`.

---

### Task 2: Worker: anonymous admission, caps and expiry

**Files:**
- Modify: `cloudflare/src/anon.js`
- Modify: `cloudflare/test/anon.test.js`
- Modify: `cloudflare/src/index.js` (`fetch` control-host branch ~line 59, `authorized` ~line 74, `handleFrame` Ping case ~line 152, `handleAuth` ~line 175)

**Interfaces:**
- Consumes: `anonName` (Task 1).
- Produces (all in `anon.js`):
  - `export function anonEnabled(env): boolean`: `env.ANONYMOUS === "1"`.
  - `export function anonLimits(env): { maxTunnels: number, maxPerIp: number, maxSeconds: number }`.
  - `export function classifyAuth({ header: string, token: string|undefined, key: string|undefined, env }): "token" | "anon" | "reject"`. Covers both layers. HTTP layer: pass `header` = the Authorization header, `token`/`key` undefined. Frame layer: pass `header` undefined.
  - `export function admitAnon({ name, ip, others, limits }): string | null`. Returns a reject reason or null. `others` = `[{ name, ip, anon }]` for OPEN sockets other than this one.
  - `export function expiredReason(since: number, now: number, limits): string | null`. Times are in ms.
- Attachment shape on anonymous sockets: `{ scheme, port, name, anon: true, ip, since }`.

- [ ] **Step 1: Write failing tests** in `anon.test.js`:
  - `anonLimits({})` → `{maxTunnels: 8, maxPerIp: 2, maxSeconds: 7200}`. `anonLimits({ANON_MAX_TUNNELS: "50", ANON_MAX_PER_IP: "x", ANON_MAX_SECONDS: "-1"})` → `{50, 2, 7200}`.
  - `classifyAuth`, with `env = {RELAY_TOKEN: "s3cret", ANONYMOUS: "1"}`:
    - HTTP: header `"Bearer s3cret"` → `"token"`. No header → `"anon"`. Header `"Bearer wrong"` → `"reject"`.
    - Frame: token `"s3cret"` → `"token"`. Token `"wrong"` with a valid key → `"reject"`. Empty token with a key → `"anon"`.
    - With `ANONYMOUS` unset: no header → `"reject"`, and empty token with a key → `"reject"`.
  - `admitAnon`, with limits `{maxTunnels: 2, maxPerIp: 2, maxSeconds: 7200}`:
    - Two other anon sockets → the server-full reason.
    - Two token sockets plus one anon socket → null (token sockets don't count).
    - Two anon sockets from the same IP → `too many tunnels from your IP (max 2)`.
    - **Review Focus #2:** two anon sockets from this IP, one of them with this socket's own `name` → null (it will be displaced, so it doesn't count).
  - `expiredReason(0, 7_199_000, l)` → null. `expiredReason(0, 7_200_000, l)` → `tunnel expired after 2h`. With `maxSeconds: 90` at 90_000 → `tunnel expired after 90s`.
- [ ] **Step 2: Run** `cd cloudflare && npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the five functions in `anon.js`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Wire into `index.js`:**
  - Control-host requests: `classifyAuth({header, env})`. `"reject"` → 401.
  - In `connect`, add `ip: request.headers.get("cf-connecting-ip") ?? ""` to the attachment.
  - In `handleAuth`, classify the frame. On `"anon"`: `name = await anonName(auth.key)` (null → reject `invalid key`). Build `others` from OPEN sockets other than `ws`. If `admitAnon` gives a reason, reject with it. Store `anon: true, since: Date.now()`. Then the existing displace-and-ack path, with `name` replacing `auth.name`. `handleAuth` becomes async. Make `handleFrame`'s caller await it, or `.catch` it into `reject`.
  - In the Ping case, before sending Pong: if the attachment has `anon` and `expiredReason` returns a reason, reject with it and return.
- [ ] **Step 6: Smoke test** with `wrangler dev` (see Task 5, Step 3). Steps 1-3 there must pass.
- [ ] **Step 7: Commit** `feat(worker): anonymous tunnels with caps and expiry`.

---

### Task 3: Worker: visitor warning page

**Files:**
- Modify: `cloudflare/src/anon.js`, `cloudflare/test/anon.test.js`
- Modify: `cloudflare/src/index.js` (`serveVisitor` ~line 382, after the `lookup` 404)

**Interfaces:**
- Produces:
  - `export const CONTINUE_PATH = "/__relay_continue"`.
  - `export function needsWarning(request: Request): boolean`: true only for a `GET`, no `upgrade` header, `accept` containing `text/html`, and no `relay_ok=1` in the `cookie` header.
  - `export function warningPage(url: URL): Response`: status 200, `cache-control: no-store`, HTML in the same inline style as `errorPage`. Copy: heading "You're about to visit a tunnel". Body: "This page is served from someone's own computer through relay. It is not run by the owner of tnnnnnnnl.xyz. Don't enter passwords or payment details unless you trust whoever sent you this link." Button-styled link "Continue" → `CONTINUE_PATH + "?to=" + encodeURIComponent(path+search)`.
  - `export function continueResponse(url: URL): Response`: 302 to a safe `to`, with `set-cookie: relay_ok=1; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Lax`.
  - `export function safeRedirect(to: string | null): string`: returns `to` only if it starts with `/` but not `//` or `/\`. Otherwise returns `/`.
- Rule: the warning page and the continue path apply only when the target socket's attachment has `anon: true`.

- [ ] **Step 1: Write failing tests:**
  - `needsWarning` is true for `GET` with `accept: text/html,*/*`.
  - **Review Focus #4:** false for `accept: */*`, for `POST` with `text/html`, for an `upgrade: websocket` header, and with `cookie: a=b; relay_ok=1`.
  - **Review Focus #1:** `safeRedirect`: `"/x?y=1"` → `"/x?y=1"`; `"//evil.com"`, `"/\\evil.com"`, `"https://evil.com"`, `null` → `"/"`.
  - `continueResponse(new URL("https://t.x/__relay_continue?to=%2Fa"))`: status 302, `location` is `/a`, and `set-cookie` includes `relay_ok=1` and `Max-Age=86400`.
  - `warningPage` contains `/__relay_continue?to=%2Fdocs%3Fq%3D1` for `https://t.x/docs?q=1`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** in `anon.js`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Wire** in `serveVisitor`, after the 404 and only for anon sockets: if the path is `CONTINUE_PATH`, return `continueResponse(url)`. Else if `needsWarning(request)`, return `warningPage(url)`.
- [ ] **Step 6: Smoke test:** Task 5, Step 3, item 4.
- [ ] **Step 7: Commit** `feat(worker): warning page for visitors of anonymous tunnels`.

---

### Task 4: Client: default server and anonymous mode

**Files:**
- Modify: `cmd/relay/config.go` (new helpers at the end)
- Modify: `cmd/relay/config_test.go`
- Modify: `cmd/relay/main.go` (server/token block ~lines 86-140, `authMsg` marshal ~line 195, dial header ~line 288, usage text ~line 63)

**Interfaces:**
- Consumes: `protocol.NewAnonKey`, `protocol.AnonName`, `Auth.Key` (Task 1).
- Produces:
  - `const defaultServer = "https://relay.tnnnnnnnl.xyz"` in `config.go`.
  - `func pickServer(flagServer string, cfg clientConfig, explicitRelay bool) string`: flag, else saved, else `defaultServer`. Returns `""` when `explicitRelay`.
  - `func anonymousMode(server, token string, nameSet bool) (bool, error)`: true when `server != ""` and `token == ""`. Error when it would be true and `nameSet` is set: `custom names need your own server or a token: https://github.com/shahnewaz-labib/relay#readme`.
  - A package-level `anonKey string`, set once in `main` when anonymous.

- [ ] **Step 1: Write failing tests** in `config_test.go`:
  - **Review Focus #5:** `TestPickServer`, table-driven:
    - `("", {}, false)` → `defaultServer`.
    - `("", {Server: "https://mine.example"}, false)` → `"https://mine.example"`.
    - `("https://flag.example", {Server: "https://mine.example"}, false)` → `"https://flag.example"`.
    - `("", {Server: "https://mine.example"}, true)` → `""`.
  - `TestAnonymousMode`:
    - `(defaultServer, "", false)` → `(true, nil)`.
    - `(defaultServer, "tok", false)` → `(false, nil)`.
    - `(defaultServer, "", true)` → error containing `custom names need your own server or a token`.
    - `("", "", false)` → `(false, nil)`. Raw TCP mode still needs a token.
- [ ] **Step 2: Run** `go test ./cmd/relay/ -run 'PickServer|AnonymousMode'`. Expected: FAIL.
- [ ] **Step 3: Implement** both helpers.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Wire into `main.go`:**
  - Replace `*serverURL = cfg.Server` with `pickServer`. Keep the existing rule that clears the saved token when the explicit server differs from the saved one.
  - Remove the `no server configured` fatal. It can't happen now.
  - Track whether `--name` was set, using the existing `flag.Visit` loop.
  - Call `anonymousMode`: an error is fatal. If anonymous, set `anonKey` from `NewAnonKey()` and `*name` from `AnonName(anonKey)`. Otherwise keep the existing `no token` fatal and random-name path.
  - Marshal `authMsg{Name: *name, Token: *token, Key: anonKey}`.
  - Send the `Authorization` header only when `*token != ""`.
  - Usage line: `Usage: relay <port> [flags]   (uses relay.tnnnnnnnl.xyz unless you run relay setup)`.
- [ ] **Step 6: Run** `gofmt -l . && go vet ./... && go test -race -count=1 ./...`. Expected: no gofmt output, all PASS.
- [ ] **Step 7: Commit** `feat(client): default to the hosted relay without setup`.

---

### Task 5: Config, docs and end-to-end check

**Files:**
- Modify: `cloudflare/wrangler.jsonc`, `cloudflare/wrangler.dev.jsonc` (add `"ANONYMOUS": "1"` to `vars`)
- Modify: `README.md`, `docs/cloudflare.md`

- [ ] **Step 1: Config.** Add `ANONYMOUS: "1"` to both files' `vars`, with a one-line comment in `wrangler.jsonc`: self-hosters remove it to require the token.
- [ ] **Step 2: Docs.**
  - README quick start leads with `relay 3000` → public URL on the hosted relay, and lists the limits (2h, 2 per IP, shared capacity). Self-hosting (`relay setup`) comes second.
  - Remove the "One shared token" limitation line only if it's no longer accurate. It still is for self-hosting, so reword it.
  - `docs/cloudflare.md`: a table of `ANONYMOUS`, `ANON_MAX_TUNNELS`, `ANON_MAX_PER_IP`, `ANON_MAX_SECONDS`, plus a sentence tying 8 to the 100k/day budget (8 × ~8,600 ≈ 69k).
- [ ] **Step 3: End-to-end smoke test** against `cd cloudflare && npx wrangler dev -c wrangler.dev.jsonc` (port 8787) with a local `python3 -m http.server 3000`. Build with `go build -o /tmp/relay ./cmd/relay`. Use `RELAY_CONFIG=$(mktemp -d)/c.json` so your real config is untouched.
  1. `/tmp/relay 3000 --server http://localhost:8787` with no token prints `http://tunnel-<12hex>.localhost:8787`.
  2. `curl -H 'Host: tunnel-<hex>.localhost' localhost:8787/` returns the directory listing (curl sends `*/*`, so there's no warning page).
  3. Start two more clients the same way. The third prints `relay rejected us: too many tunnels from your IP (max 2)` and exits non-zero.
  4. `curl -H 'Host: tunnel-<hex>.localhost' -H 'Accept: text/html' localhost:8787/` returns the warning page. Repeating it with `-H 'Cookie: relay_ok=1'` returns the listing.
  5. Restart wrangler with `--var ANON_MAX_SECONDS:20`. The client exits with `relay rejected us: tunnel expired after 20s` within about 30s.
  6. With `.dev.vars` `RELAY_TOKEN=t`: `RELAY_TOKEN=t /tmp/relay 3000 --server http://localhost:8787 --name demo` still works while the anonymous cap is full.
- [ ] **Step 4: Run** `go test -race -count=1 ./... && (cd cloudflare && npm test)`. Expected: PASS.
- [ ] **Step 5: Commit** `docs: lead with the hosted relay; enable anonymous mode in production`.

Deploying (merging to master triggers `deploy.yml`) is the user's call, not part of this plan.
