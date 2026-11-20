import assert from "node:assert/strict";
import test from "node:test";

import {
  admitAnon,
  anonLimits,
  anonName,
  authTimeoutReason,
  classifyAuth,
  continueAllowed,
  continueResponse,
  ipKey,
  expiredReason,
  needsWarning,
  safeRedirect,
  stripRelayCookie,
  warningPage,
} from "../src/anon.js";

test("anonName matches the shared vector", async () => {
  assert.equal(await anonName("0".repeat(64)), "tunnel-60e05bd1b195");
});

test("anonName rejects malformed keys", async () => {
  for (const key of ["", "0".repeat(63), "A".repeat(64), "g".repeat(64), undefined]) {
    assert.equal(await anonName(key), null, `key ${key}`);
  }
});

const FULL = "server full, try later or self-host: https://github.com/shahnewaz-labib/relay#readme";
const KEY = "0".repeat(64);

test("anonLimits uses defaults for missing or bad values", () => {
  assert.deepEqual(anonLimits({}), { maxTunnels: 8, maxPerIp: 2, maxSeconds: 7200 });
  assert.deepEqual(
    anonLimits({ ANON_MAX_TUNNELS: "50", ANON_MAX_PER_IP: "x", ANON_MAX_SECONDS: "-1" }),
    { maxTunnels: 50, maxPerIp: 2, maxSeconds: 7200 },
  );
});

test("classifyAuth at the HTTP layer", () => {
  const env = { RELAY_TOKEN: "s3cret", ANONYMOUS: "1" };
  assert.equal(classifyAuth({ header: "Bearer s3cret", env }), "token");
  assert.equal(classifyAuth({ header: null, env }), "anon");
  assert.equal(classifyAuth({ header: "", env }), "anon");
  assert.equal(classifyAuth({ header: "Bearer wrong", env }), "reject");
  assert.equal(classifyAuth({ header: null, env: { RELAY_TOKEN: "s3cret" } }), "reject");
});

test("classifyAuth at the frame layer", () => {
  const env = { RELAY_TOKEN: "s3cret", ANONYMOUS: "1" };
  assert.equal(classifyAuth({ token: "s3cret", env }), "token");
  assert.equal(classifyAuth({ token: "wrong", key: KEY, env }), "reject");
  assert.equal(classifyAuth({ token: "", key: KEY, env }), "anon");
  assert.equal(classifyAuth({ token: "", key: KEY, env: { RELAY_TOKEN: "s3cret" } }), "reject");
  assert.equal(classifyAuth({ token: "", env }), "reject", "no key, no token");
});

test("admitAnon enforces caps on anonymous tunnels only", () => {
  const limits = { maxTunnels: 2, maxPerIp: 2, maxSeconds: 7200 };
  const anon = (name, ip) => ({ name, ip, anon: true });
  const tok = (name) => ({ name, ip: "9.9.9.9", anon: false });
  assert.equal(admitAnon({ name: "n", ip: "1.1.1.1", others: [anon("a", "2.2.2.2"), anon("b", "3.3.3.3")], limits }), FULL);
  assert.equal(admitAnon({ name: "n", ip: "1.1.1.1", others: [tok("a"), tok("b"), anon("c", "2.2.2.2")], limits }), null);
  assert.equal(
    admitAnon({ name: "n", ip: "1.1.1.1", others: [anon("a", "1.1.1.1"), anon("b", "1.1.1.1")], limits: { ...limits, maxTunnels: 8 } }),
    "too many tunnels from your IP (max 2)",
  );
  // A lingering socket for our own name gets displaced, so it does not count.
  assert.equal(admitAnon({ name: "n", ip: "1.1.1.1", others: [anon("n", "1.1.1.1"), anon("b", "1.1.1.1")], limits }), null);
});

test("expiredReason after maxSeconds", () => {
  const l = { maxTunnels: 8, maxPerIp: 2, maxSeconds: 7200 };
  assert.equal(expiredReason(0, 7_199_000, l), null);
  assert.equal(expiredReason(0, 7_200_000, l), "tunnel expired after 2h");
  assert.equal(expiredReason(0, 90_000, { ...l, maxSeconds: 90 }), "tunnel expired after 90s");
});

const req = (method, headers) => new Request("https://t.example/", { method, headers });

test("needsWarning only for browser page loads without the cookie", () => {
  assert.equal(needsWarning(req("GET", { accept: "text/html,*/*" })), true);
  assert.equal(needsWarning(req("GET", { accept: "*/*" })), false);
  assert.equal(needsWarning(req("POST", { accept: "text/html" })), false);
  assert.equal(needsWarning(req("GET", { accept: "text/html", upgrade: "websocket" })), false);
  assert.equal(needsWarning(req("GET", { accept: "text/html", cookie: "a=b; __Host-relay_ok=1" })), false);
  // The old name could be set for the whole domain by any tunnel.
  assert.equal(needsWarning(req("GET", { accept: "text/html", cookie: "relay_ok=1" })), true);
});

test("safeRedirect keeps same-site paths only", () => {
  assert.equal(safeRedirect("/x?y=1"), "/x?y=1");
  for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", null, "", "/\t/evil.com", "/\t\\evil.com", "/a\nb", "/a\u007fb"]) {
    assert.equal(safeRedirect(bad), "/", `to=${bad}`);
  }
});

test("continueResponse sets the cookie and redirects back", () => {
  const res = continueResponse(new URL("https://t.x/__relay_continue?to=%2Fa"));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/a");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^__Host-relay_ok=1;/);
  assert.match(cookie, /Max-Age=86400/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/i, "__Host- cookies must be host-only");
});

test("warningPage links back to the original path", async () => {
  const res = warningPage(new URL("https://t.x/docs?q=1"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(await res.text(), /\/__relay_continue\?to=%2Fdocs%3Fq%3D1/);
});

test("continueAllowed only from the warning page itself", () => {
  const url = new URL("https://t.x/__relay_continue?to=%2F");
  const r = (headers) => new Request(url, { headers });
  assert.equal(continueAllowed(r({}), url), false, "a direct link");
  assert.equal(continueAllowed(r({ "sec-fetch-site": "cross-site" }), url), false);
  assert.equal(continueAllowed(r({ "sec-fetch-site": "same-site" }), url), false, "another tunnel");
  assert.equal(continueAllowed(r({ "sec-fetch-site": "same-origin" }), url), true);
  assert.equal(continueAllowed(r({ referer: "https://t.x/docs" }), url), true);
  assert.equal(continueAllowed(r({ referer: "https://other.t.x/" }), url), false);
  assert.equal(continueAllowed(r({ referer: "not a url" }), url), false);
});

test("authTimeoutReason drops sockets that never authenticate", () => {
  assert.equal(authTimeoutReason({ connectedAt: 0 }, 9_999), null);
  assert.equal(authTimeoutReason({ connectedAt: 0 }, 10_000), "no auth within 10s");
  assert.equal(authTimeoutReason({ connectedAt: 0, name: "n" }, 99_999), null);
  assert.equal(authTimeoutReason({}, 99_999), null, "sockets from before this field existed");
});

test("ipKey groups an IPv6 /64 and keeps IPv4 as is", () => {
  assert.equal(ipKey("1.2.3.4"), "1.2.3.4");
  assert.equal(ipKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:DB8:1:2::5"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipKey(""), "");
});

test("stripRelayCookie removes only the relay cookie from origin responses", () => {
  const h = new Headers();
  h.append("set-cookie", "session=abc; Path=/");
  h.append("set-cookie", "__Host-relay_ok=1; Path=/; Secure");
  h.append("set-cookie", "__host-RELAY_OK=1; Path=/; Secure");
  h.append("set-cookie", "theme=dark");
  h.set("content-type", "text/plain");
  stripRelayCookie(h);
  assert.deepEqual(h.getSetCookie(), ["session=abc; Path=/", "theme=dark"]);
  assert.equal(h.get("content-type"), "text/plain");
});
