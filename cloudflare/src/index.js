// Cloudflare backend for Relay: a Worker that routes visitor traffic and
// tunnel WebSockets into one Durable Object.
//
// This speaks the same relay/1 protocol as relayd, so the existing Go client
// connects with no changes — only `relay setup --server <origin>` differs.

import {
  ChunkedDecoder,
  FrameParser,
  PONG_BYTES,
  T,
  VERSION,
  encodeData,
  encodeFrame,
  parseResponseHead,
  serializeRequest,
} from "./protocol.js";

const CONNECT_PATH = "/_relay/connect";
const CHECK_PATH = "/_relay/check";
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// ponytail: one hub object holds every tunnel. Simple and correct; it is also
// a single-threaded throughput ceiling. Shard by tunnel name (idFromName(name))
// if one object ever saturates.
const HUB = "hub";

export default {
  async fetch(request, env) {
    return env.HUB.get(env.HUB.idFromName(HUB)).fetch(request);
  },
};

export class TunnelHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Runtime state cannot survive hibernation, so it is rebuilt per wake.
    this.runtime = new Map(); // ws -> { parser, nextId, pending: Map }
    // Keepalives are a fixed 13-byte frame, so the runtime can answer them
    // without waking this object at all. Binary auto-response is best effort;
    // webSocketMessage still replies if it does not match.
    // ponytail: no setWebSocketAutoResponse. The pair is string-based, so a
    // match would answer a binary Ping with a TEXT frame, which the Go
    // client's binary NetConn rejects. Each 10s keepalive therefore wakes this
    // object; that is ~8.6k of the 100k daily requests per tunnel.
  }

  async fetch(request) {
    const url = new URL(request.url);
    const host = (request.headers.get("host") ?? url.hostname).split(":")[0].toLowerCase();

    if (host === this.env.CONTROL_HOST) {
      if (url.pathname === CHECK_PATH || url.pathname === CONNECT_PATH) {
        if (request.method !== "GET") {
          return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
        }
        if (!this.authorized(request)) return new Response("unauthorized", { status: 401 });
        return url.pathname === CHECK_PATH ? this.check() : this.connect(request, url);
      }
    }

    const suffix = "." + this.env.TUNNEL_SUFFIX.toLowerCase();
    if (!host.endsWith(suffix)) return errorPage(404, "No tunnel for this hostname.");
    const name = host.slice(0, -suffix.length);
    if (!NAME_RE.test(name)) return errorPage(404, "No tunnel for this hostname.");
    return this.serveVisitor(request, url, host, name);
  }

  authorized(request) {
    const expected = `Bearer ${this.env.RELAY_TOKEN}`;
    const got = request.headers.get("authorization") ?? "";
    return this.env.RELAY_TOKEN && timingSafeEqual(got, expected);
  }

  check() {
    return Response.json({ protocol: VERSION }, { headers: { "cache-control": "no-store" } });
  }

  connect(request, url) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((s) => s.trim());
    if (!offered.includes(VERSION)) {
      return new Response(`${VERSION} subprotocol required`, { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // Remember how the client reached us, so the announced visitor URL is
    // right in production (https, default port) and under `wrangler dev`
    // (http, :8787) without a second copy of that in configuration.
    server.serializeAttachment({
      scheme: url.protocol.replace(":", ""),
      port: url.port,
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": VERSION },
    });
  }

  // ---- tunnel side ----

  stateFor(ws) {
    let st = this.runtime.get(ws);
    if (!st) {
      // After hibernation any half-read frame is gone. The client reconnects
      // with backoff, so a dropped tunnel is self-healing.
      st = { parser: new FrameParser(), nextId: 1, pending: new Map() };
      this.runtime.set(ws, st);
    }
    return st;
  }

  // A socket whose client died abruptly can linger here for a moment. Ignore
  // anything not OPEN, or its name stays claimed and the client's reconnect is
  // rejected as a duplicate.
  lookup(name) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      if (ws.deserializeAttachment()?.name === name) return ws;
    }
    return null;
  }

  async webSocketMessage(ws, message) {
    const bytes =
      typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
    const st = this.stateFor(ws);
    let frames;
    try {
      frames = st.parser.push(bytes);
    } catch (err) {
      this.drop(ws, 1002, String(err));
      return;
    }
    for (const frame of frames) this.handleFrame(ws, st, frame);
  }

  handleFrame(ws, st, frame) {
    switch (frame.type) {
      case T.Ping:
        ws.send(PONG_BYTES);
        return;
      case T.Pong:
        return;
      case T.Auth:
        this.handleAuth(ws, frame);
        return;
      // Frame IDs decode as BigInt; pending streams are keyed by Number.
      // Map treats 1n and 1 as different keys, so normalise on every lookup.
      case T.Data: {
        const pending = st.pending.get(Number(frame.id));
        // subarray aliases the parser buffer, which is reused; copy it.
        if (pending) pending.onBytes(frame.body.slice());
        return;
      }
      case T.Fin: {
        const pending = st.pending.get(Number(frame.id));
        if (pending) pending.onEnd();
        return;
      }
      default:
        return; // Syn/AuthAck/Reject are server-to-client only
    }
  }

  handleAuth(ws, frame) {
    let auth;
    try {
      auth = JSON.parse(new TextDecoder().decode(frame.body));
    } catch {
      return this.reject(ws, "malformed auth");
    }
    if (!this.env.RELAY_TOKEN || !timingSafeEqual(auth.token ?? "", this.env.RELAY_TOKEN)) {
      return this.reject(ws, "bad token");
    }
    if (!NAME_RE.test(auth.name ?? "")) return this.reject(ws, "invalid tunnel name");
    const existing = this.lookup(auth.name);
    if (existing && existing !== ws) {
      return this.reject(ws, "name already connected; choose another --name");
    }
    const origin = ws.deserializeAttachment() ?? {};
    ws.serializeAttachment({ ...origin, name: auth.name });
    const scheme = origin.scheme === "http" ? "http" : "https";
    const hostname = `${auth.name}.${this.env.TUNNEL_SUFFIX}`;
    const authority = origin.port ? `${hostname}:${origin.port}` : hostname;
    const ack = {
      url: `${scheme}://${authority}`,
      domain: this.env.TUNNEL_SUFFIX,
      host: hostname,
      port: origin.port || (scheme === "https" ? "443" : "80"),
      scheme,
    };
    ws.send(encodeFrame(T.AuthAck, 0, new TextEncoder().encode(JSON.stringify(ack))));
  }

  reject(ws, reason) {
    try {
      ws.send(encodeFrame(T.Reject, 0, new TextEncoder().encode(reason)));
    } catch {
      // socket already gone
    }
    this.drop(ws, 1008, reason);
  }

  drop(ws, code, reason) {
    const st = this.runtime.get(ws);
    if (st) for (const pending of st.pending.values()) pending.onEnd();
    this.runtime.delete(ws);
    try {
      ws.close(code, reason.slice(0, 120));
    } catch {
      // already closed
    }
  }

  webSocketClose(ws) {
    this.drop(ws, 1000, "closed");
  }

  webSocketError(ws) {
    this.drop(ws, 1011, "error");
  }

  // ---- visitor side ----

  async serveVisitor(request, url, host, name) {
    // ponytail: visitor WebSocket upgrades are not bridged yet. The origin
    // speaks raw WebSocket frames over the tunnel; relaying them means
    // re-encoding RFC 6455 framing in the Worker. HMR needs the VPS backend.
    if (request.headers.get("upgrade")) {
      return errorPage(501, "This backend does not forward WebSocket upgrades yet.");
    }

    const ws = this.lookup(name);
    if (!ws) return errorPage(404, `No tunnel named "${name}" is connected.`);

    // ponytail: the request body is buffered so the origin gets a
    // Content-Length. Switch to chunked transfer if large uploads matter.
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > 25 * 1024 * 1024) {
      return errorPage(413, "Request body over 25 MB is not supported by this backend.");
    }

    const st = this.stateFor(ws);
    const id = st.nextId++;
    const pending = newPending();
    st.pending.set(id, pending);

    try {
      ws.send(encodeFrame(T.Syn, id, null));
      const head = serializeRequest(request.method, url, request.headers, host, body.length);
      for (const frame of encodeData(id, head)) ws.send(frame);
      for (const frame of encodeData(id, body)) ws.send(frame);
    } catch (err) {
      st.pending.delete(id);
      return errorPage(502, `Tunnel write failed: ${err}`);
    }

    const timer = setTimeout(() => pending.fail(new Error("origin timed out")), 30_000);
    try {
      const head = await pending.headReady;
      if (head.status === 204 || head.status === 304) {
        return new Response(null, {
          status: head.status,
          statusText: head.statusText,
          headers: head.headers,
        });
      }
      // We asked the origin for identity, but some ignore that. Decode here
      // rather than hand the runtime a compressed body it will mislabel.
      let body = pending.body;
      const codec = { gzip: "gzip", "x-gzip": "gzip", deflate: "deflate" }[head.contentEncoding];
      if (codec) {
        body = body.pipeThrough(new DecompressionStream(codec));
        head.headers.delete("content-length"); // no longer the decoded length
      }
      return new Response(body, {
        status: head.status,
        statusText: head.statusText,
        headers: head.headers,
      });
    } catch (err) {
      return errorPage(502, `The tunnel client did not return a response: ${err.message}`);
    } finally {
      clearTimeout(timer);
      pending.whenDone.then(() => {
        st.pending.delete(id);
        // Release the client's stream now that the response is complete.
        try {
          ws.send(encodeFrame(T.Fin, id, null));
        } catch {
          // socket already gone
        }
      });
    }
  }
}

// newPending tracks one visitor request: a promise for the response head and a
// ReadableStream carrying the body as Data frames arrive.
function newPending() {
  let resolveHead, rejectHead, resolveDone;
  const headReady = new Promise((res, rej) => {
    resolveHead = res;
    rejectHead = rej;
  });
  const whenDone = new Promise((res) => {
    resolveDone = res;
  });

  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      state.finish();
    },
  });

  const state = {
    headReady,
    whenDone,
    body,
    head: null,
    buf: new Uint8Array(0),
    decoder: null,
    received: 0,
    finished: false,

    onBytes(bytes) {
      if (state.finished) return;
      try {
        if (!state.head) {
          const merged = new Uint8Array(state.buf.length + bytes.length);
          merged.set(state.buf);
          merged.set(bytes, state.buf.length);
          state.buf = merged;
          const head = parseResponseHead(state.buf);
          if (!head) return;
          state.head = head;
          state.buf = new Uint8Array(0);
          if (head.chunked) state.decoder = new ChunkedDecoder();
          resolveHead(head);
          if (head.contentLength === 0) return state.finish();
          if (head.rest.length) state.writeBody(head.rest);
          return;
        }
        state.writeBody(bytes);
      } catch (err) {
        state.fail(err);
      }
    },

    writeBody(bytes) {
      const head = state.head;
      if (head.chunked) {
        const out = state.decoder.feed(bytes);
        if (out.length) controller.enqueue(out);
        if (state.decoder.done) state.finish();
        return;
      }
      if (head.contentLength != null) {
        const room = head.contentLength - state.received;
        const take = bytes.subarray(0, Math.max(0, room));
        if (take.length) {
          controller.enqueue(take);
          state.received += take.length;
        }
        if (state.received >= head.contentLength) state.finish();
        return;
      }
      // No length and no chunking: the body runs until the stream ends.
      controller.enqueue(bytes);
    },

    onEnd() {
      state.finish();
    },

    fail(err) {
      if (state.finished) return;
      state.finished = true;
      if (!state.head) rejectHead(err);
      else safeError(controller, err);
      resolveDone();
    },

    finish() {
      if (state.finished) return;
      state.finished = true;
      if (!state.head) rejectHead(new Error("tunnel closed before the response head"));
      else safeClose(controller);
      resolveDone();
    },
  };
  return state;
}

function safeClose(controller) {
  try {
    controller.close();
  } catch {
    // already closed or cancelled
  }
}

function safeError(controller, err) {
  try {
    controller.error(err);
  } catch {
    // already closed or cancelled
  }
}

// Constant-time string compare, so a wrong token leaks no timing signal.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function errorPage(status, message) {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>relay ${status}</title>` +
      `<body style="font:16px system-ui;max-width:32rem;margin:4rem auto">` +
      `<h1>relay ${status}</h1><p>${message}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
