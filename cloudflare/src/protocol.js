// relay/1 framing and the HTTP/1.1 bridge, as pure functions.
//
// The Go client is the reference implementation (internal/wire). It writes a
// frame as TWO socket writes — 13-byte header, then payload — so over a
// WebSocket every frame arrives as two separate messages. Parse the byte
// stream; never assume one message is one frame.
//
//   [type: u8][stream ID: u64 BE][payload length: u32 BE][payload]

export const T = {
  Syn: 1,
  Data: 2,
  Fin: 3,
  Ping: 4,
  Pong: 5,
  Auth: 6,
  AuthAck: 7,
  Reject: 8,
};

export const VERSION = "relay/1";
const HEADER = 13;
const MAX_PAYLOAD = 1 << 20;
const CHUNK = 1 << 16; // match the Go writer's outbound Data chunk size

export function encodeFrame(type, id, body) {
  const payload = body ?? new Uint8Array(0);
  const out = new Uint8Array(HEADER + payload.length);
  const dv = new DataView(out.buffer);
  out[0] = type;
  dv.setBigUint64(1, BigInt(id));
  dv.setUint32(9, payload.length);
  out.set(payload, HEADER);
  return out;
}

// Data payloads above CHUNK are split, as the Go writer does.
export function encodeData(id, bytes) {
  const frames = [];
  for (let off = 0; off < bytes.length; off += CHUNK) {
    frames.push(encodeFrame(T.Data, id, bytes.subarray(off, off + CHUNK)));
  }
  return frames;
}

export const PONG_BYTES = encodeFrame(T.Pong, 0, null);

export class FrameParser {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  // Returns every complete frame now available. Throws on a malformed stream,
  // which the caller should treat as fatal for that connection.
  push(bytes) {
    if (this.buf.length === 0) {
      this.buf = bytes;
    } else {
      const merged = new Uint8Array(this.buf.length + bytes.length);
      merged.set(this.buf);
      merged.set(bytes, this.buf.length);
      this.buf = merged;
    }

    const frames = [];
    let off = 0;
    while (this.buf.length - off >= HEADER) {
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + off, HEADER);
      const type = dv.getUint8(0);
      const id = dv.getBigUint64(1);
      const length = dv.getUint32(9);
      if (type < T.Syn || type > T.Reject || length > MAX_PAYLOAD) {
        throw new Error(`relay: bad frame type=${type} length=${length}`);
      }
      if (this.buf.length - off - HEADER < length) break;
      frames.push({
        type,
        id,
        body: this.buf.subarray(off + HEADER, off + HEADER + length),
      });
      off += HEADER + length;
    }
    this.buf = off === 0 ? this.buf : this.buf.subarray(off);
    return frames;
  }
}

// ---- HTTP/1.1 ----

// Headers the origin must not see, and response headers the runtime owns.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const encoder = new TextEncoder();

export function serializeRequest(method, url, headers, host, bodyLength) {
  const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`];
  lines.push(`Host: ${host}`);
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "accept-encoding") continue;
    lines.push(`${name}: ${value}`);
  }
  // Ask the origin not to compress. The Workers runtime treats a constructed
  // Response body as already decoded, so a compressed one gets re-compressed
  // and its Content-Encoding overwritten — the visitor then renders raw gzip.
  // Cloudflare still compresses at the edge, so nothing is lost on the wire.
  lines.push("Accept-Encoding: identity");
  // The stream is closed by Fin only when the visitor aborts, so the origin
  // needs an explicit length to know the request ended.
  lines.push(`Content-Length: ${bodyLength}`);
  lines.push("Connection: close");
  return encoder.encode(lines.join("\r\n") + "\r\n\r\n");
}

function indexOfHeaderEnd(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

// Parses a response head. Returns null while more bytes are needed.
export function parseResponseHead(buf) {
  const end = indexOfHeaderEnd(buf);
  if (end < 0) {
    if (buf.length > 64 * 1024) throw new Error("relay: response head too large");
    return null;
  }
  const text = new TextDecoder().decode(buf.subarray(0, end));
  const [statusLine, ...rawHeaders] = text.split("\r\n");
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!match) throw new Error(`relay: bad status line ${JSON.stringify(statusLine)}`);

  const status = Number(match[1]);
  const headers = new Headers();
  let contentLength = null;
  let chunked = false;
  let contentEncoding = "";
  for (const line of rawHeaders) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const lower = name.toLowerCase();
    if (lower === "content-length") contentLength = Number(value);
    if (lower === "transfer-encoding" && value.toLowerCase().includes("chunked")) chunked = true;
    if (lower === "content-encoding") {
      // Never forwarded: the caller hands the runtime an identity body, and a
      // stale Content-Encoding here makes the edge mislabel the response.
      contentEncoding = value.toLowerCase();
      continue;
    }
    if (HOP_BY_HOP.has(lower)) continue;
    headers.append(name, value); // append keeps repeated Set-Cookie intact
  }

  // 1xx, 204 and 304 carry no body regardless of headers.
  const bodyless = status < 200 || status === 204 || status === 304;
  return {
    status,
    statusText: match[2] ?? "",
    headers,
    chunked,
    contentEncoding,
    contentLength: bodyless ? 0 : contentLength,
    rest: buf.subarray(end + 4),
  };
}

// Incremental de-chunker. feed() returns decoded bytes; done turns true at the
// terminating zero-length chunk.
export class ChunkedDecoder {
  constructor() {
    this.buf = new Uint8Array(0);
    this.remaining = 0;
    this.done = false;
    this.inTrailer = false;
  }

  feed(bytes) {
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf);
    merged.set(bytes, this.buf.length);
    this.buf = merged;

    const out = [];
    for (;;) {
      if (this.done) break;
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, this.buf.length);
        if (take === 0) break;
        out.push(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        continue;
      }
      // Between chunks: consume CRLF, then a size line.
      const nl = findCRLF(this.buf);
      if (nl < 0) break;
      const line = new TextDecoder().decode(this.buf.subarray(0, nl)).trim();
      this.buf = this.buf.subarray(nl + 2);
      if (line === "") continue; // trailing CRLF after a chunk's data
      if (this.inTrailer) continue;
      const size = parseInt(line.split(";")[0], 16);
      if (Number.isNaN(size)) throw new Error(`relay: bad chunk size ${JSON.stringify(line)}`);
      if (size === 0) {
        this.done = true;
        break;
      }
      this.remaining = size;
    }

    let total = 0;
    for (const part of out) total += part.length;
    const joined = new Uint8Array(total);
    let off = 0;
    for (const part of out) {
      joined.set(part, off);
      off += part.length;
    }
    return joined;
  }
}

function findCRLF(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}
