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

// ---- visitor warning page ----

export const CONTINUE_PATH = "/__relay_continue";
const COOKIE = "relay_ok=1";

// Only browser page loads are interrupted. APIs, assets, form posts and
// WebSockets pass straight through, so the tunnel still works for tools.
export function needsWarning(request) {
  if (request.method !== "GET" || request.headers.has("upgrade")) return false;
  if (!(request.headers.get("accept") ?? "").includes("text/html")) return false;
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((c) => c.trim());
  return !cookies.includes(COOKIE);
}

export function warningPage(url, domain = "tnnnnnnnl.xyz") {
  const to = encodeURIComponent(url.pathname + url.search);
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">` +
      `<title>You're about to visit a tunnel</title>` +
      `<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>You're about to visit a tunnel</h1>` +
      `<p>This page is served from someone's own computer through relay. It is not run ` +
      `by the owner of ${domain}. Don't enter passwords or payment details unless you ` +
      `trust whoever sent you this link.</p>` +
      `<p><a href="${CONTINUE_PATH}?to=${to}" style="display:inline-block;padding:.6rem 1.2rem;` +
      `background:#111;color:#fff;border-radius:6px;text-decoration:none">Continue</a></p></body>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export function continueResponse(url) {
  return new Response(null, {
    status: 302,
    headers: {
      location: safeRedirect(url.searchParams.get("to")),
      "set-cookie": `${COOKIE}; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
    },
  });
}

// A same-site path, or "/". Browsers read "//host" and "/\host" as other
// sites, and drop tabs and newlines first, so "/<tab>/host" is one too.
// Control characters and backslashes are refused anywhere.
export function safeRedirect(to) {
  if (!to || !to.startsWith("/") || to.startsWith("//") || /[\x00-\x1f\x7f\\]/.test(to)) return "/";
  return to;
}

// The continue link only counts when followed from the warning page on this
// same host. A link straight to it, sent by a phisher, gets the warning page.
export function continueAllowed(request, url) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  try {
    return new URL(request.headers.get("referer") ?? "").origin === url.origin;
  } catch {
    return false;
  }
}

// A socket that never sends Auth is never counted against the caps, so it
// must not stay. Keepalives run the check.
export function authTimeoutReason(attachment, now) {
  if (attachment.name || typeof attachment.connectedAt !== "number") return null;
  return now - attachment.connectedAt >= 10_000 ? "no auth within 10s" : null;
}

// The key the per-IP cap counts by. One IPv6 connection usually owns a whole
// /64, so addresses inside it count as one client.
export function ipKey(ip) {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
