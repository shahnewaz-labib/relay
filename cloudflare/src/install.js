// Serves install.sh at https://<CONTROL_HOST>/install, so installing is
// `curl -fsSL https://relay.tnnnnnnnl.xyz/install | sh`.

// Returns the script response, or null for any other request.
export function installResponse(request, env, script) {
  const url = new URL(request.url);
  const host = (request.headers.get("host") ?? url.hostname).split(":")[0].toLowerCase();
  if (host !== env.CONTROL_HOST || url.pathname !== "/install") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  return new Response(request.method === "HEAD" ? null : script, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
