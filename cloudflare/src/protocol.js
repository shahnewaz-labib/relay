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

// ---- RFC 6455 framing ----
//
// The origin speaks raw WebSocket frames over the tunnel, but a Worker's
// WebSocketPair hands us decoded messages. Bridging the two means doing the
// framing here. We are the CLIENT toward the origin, so frames we send are
// masked and frames we receive are not.

export const WS_OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

export function websocketKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function serializeUpgradeRequest(url, headers, host, key) {
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${key}`,
  ];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "accept-encoding") continue;
    // Forward the subprotocol only. Offering extensions such as
    // permessage-deflate would oblige us to implement frame compression.
    if (lower.startsWith("sec-websocket-") && lower !== "sec-websocket-protocol") continue;
    lines.push(`${name}: ${value}`);
  }
  return encoder.encode(lines.join("\r\n") + "\r\n\r\n");
}

export function encodeWsFrame(opcode, payload) {
  const len = payload.length;
  let headerLen;
  let header;
  if (len < 126) {
    header = new Uint8Array(6);
    header[1] = 0x80 | len;
    headerLen = 2;
  } else if (len < 65536) {
    header = new Uint8Array(8);
    header[1] = 0x80 | 126;
    new DataView(header.buffer).setUint16(2, len);
    headerLen = 4;
  } else {
    header = new Uint8Array(14);
    header[1] = 0x80 | 127;
    new DataView(header.buffer).setBigUint64(2, BigInt(len));
    headerLen = 10;
  }
  header[0] = 0x80 | opcode; // FIN set: we never fragment outbound
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  header.set(mask, headerLen);

  const out = new Uint8Array(headerLen + 4 + len);
  out.set(header.subarray(0, headerLen + 4));
  for (let i = 0; i < len; i++) out[headerLen + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

export class WsFrameDecoder {
  constructor() {
    this.buf = new Uint8Array(0);
  }

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
    for (;;) {
      if (this.buf.length - off < 2) break;
      const b0 = this.buf[off];
      const b1 = this.buf[off + 1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = off + 2;

      if (len === 126) {
        if (this.buf.length - p < 2) break;
        len = (this.buf[p] << 8) | this.buf[p + 1];
        p += 2;
      } else if (len === 127) {
        if (this.buf.length - p < 8) break;
        const big = new DataView(this.buf.buffer, this.buf.byteOffset + p, 8).getBigUint64(0);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("relay: ws frame too large");
        len = Number(big);
        p += 8;
      }

      let maskKey = null;
      if (masked) {
        if (this.buf.length - p < 4) break;
        maskKey = this.buf.subarray(p, p + 4);
        p += 4;
      }
      if (this.buf.length - p < len) break;

      const payload = this.buf.slice(p, p + len);
      if (maskKey) {
        for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
      }
      frames.push({ fin, opcode, payload });
      off = p + len;
    }
    this.buf = off === 0 ? this.buf : this.buf.subarray(off);
    return frames;
  }
}

export function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}
