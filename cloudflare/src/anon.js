// Anonymous tunnels on a public relay: name derivation, admission limits,
// expiry and the visitor warning page. Pure functions, so they test in Node.

const KEY_RE = /^[0-9a-f]{64}$/;

// Must match protocol.AnonName in Go: "tunnel-" + 12 hex of sha256(key).
export async function anonName(key) {
  if (typeof key !== "string" || !KEY_RE.test(key)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "tunnel-" + hex.slice(0, 12);
}

const SELF_HOST = "https://github.com/shahnewaz-labib/relay#readme";

export function anonEnabled(env) {
  return env.ANONYMOUS === "1";
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function anonLimits(env) {
  return {
    maxTunnels: positiveInt(env.ANON_MAX_TUNNELS, 8),
    maxPerIp: positiveInt(env.ANON_MAX_PER_IP, 2),
    maxSeconds: positiveInt(env.ANON_MAX_SECONDS, 7200),
  };
}

// Decides who a client is. Call it with `header` for the HTTP upgrade, or
// with `token` and `key` for the Auth frame. A credential that is present but
// wrong is always rejected; it never falls through to anonymous.
export function classifyAuth({ header, token, key, env }) {
  const secret = env.RELAY_TOKEN;
  if (token === undefined && key === undefined) {
    if (!header) return anonEnabled(env) ? "anon" : "reject";
    return secret && timingSafeEqual(header, `Bearer ${secret}`) ? "token" : "reject";
  }
  if (token) return secret && timingSafeEqual(token, secret) ? "token" : "reject";
  return anonEnabled(env) && key ? "anon" : "reject";
}

// Returns a reject reason, or null to admit. `others` are the relay's other
// open tunnels. One holding our own name is about to be displaced by us, so
// it does not count against the caps.
export function admitAnon({ name, ip, others, limits }) {
  const anon = others.filter((t) => t.anon && t.name !== name);
  if (anon.length >= limits.maxTunnels) return `server full, try later or self-host: ${SELF_HOST}`;
  if (anon.filter((t) => t.ip === ip).length >= limits.maxPerIp) {
    return `too many tunnels from your IP (max ${limits.maxPerIp})`;
  }
  return null;
}

export function expiredReason(since, now, limits) {
  if (now - since < limits.maxSeconds * 1000) return null;
  const s = limits.maxSeconds;
  return `tunnel expired after ${s >= 3600 ? `${Math.floor(s / 3600)}h` : `${s}s`}`;
}

// Constant-time string compare, so a wrong token leaks no timing signal.
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
