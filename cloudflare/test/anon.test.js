import assert from "node:assert/strict";
import test from "node:test";

import { admitAnon, anonLimits, anonName, classifyAuth, expiredReason } from "../src/anon.js";

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
