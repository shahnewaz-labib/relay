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
