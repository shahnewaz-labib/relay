import assert from "node:assert/strict";
import test from "node:test";

import {
  ChunkedDecoder,
  FrameParser,
  T,
  encodeData,
  encodeFrame,
  WS_OP,
  WsFrameDecoder,
  encodeWsFrame,
  parseResponseHead,
  serializeRequest,
  serializeUpgradeRequest,
} from "../src/protocol.js";

const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

// The Go writer emits a frame as two socket writes, so every frame reaches the
// Worker as a 13-byte header message followed by a payload message. Parsing
// must survive that, and any other split.
test("parses frames split across messages the way the Go client sends them", () => {
  const frame = encodeFrame(T.Data, 7, bytes("hello world"));
  const parser = new FrameParser();

  assert.deepEqual(parser.push(frame.subarray(0, 13)), [], "header alone yields nothing");
  const frames = parser.push(frame.subarray(13));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, T.Data);
  assert.equal(frames[0].id, 7n);
  assert.equal(text(frames[0].body), "hello world");
});

test("parses one byte at a time, and several frames in one message", () => {
  const stream = new Uint8Array([
    ...encodeFrame(T.Syn, 1, null),
    ...encodeFrame(T.Data, 1, bytes("ab")),
    ...encodeFrame(T.Fin, 1, null),
  ]);

  const drip = new FrameParser();
  const seen = [];
  for (const byte of stream) seen.push(...drip.push(new Uint8Array([byte])));
  assert.deepEqual(
    seen.map((f) => f.type),
    [T.Syn, T.Data, T.Fin],
  );

  const bulk = new FrameParser();
  assert.equal(bulk.push(stream).length, 3);
});

test("rejects a malformed frame instead of hanging", () => {
  const parser = new FrameParser();
  assert.throws(() => parser.push(new Uint8Array([99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
});

test("splits large payloads into 64 KiB Data frames", () => {
  const frames = encodeData(3, new Uint8Array(150_000));
  assert.equal(frames.length, 3);
  const parser = new FrameParser();
  const parsed = frames.flatMap((f) => parser.push(f));
  assert.deepEqual(
    parsed.map((f) => f.body.length),
    [65536, 65536, 18928],
  );
});

test("parses a response head, keeping repeated Set-Cookie", () => {
  const raw = bytes(
    "HTTP/1.1 200 OK\r\n" +
      "Content-Length: 5\r\n" +
      "Set-Cookie: a=1\r\n" +
      "Set-Cookie: b=2\r\n" +
      "Connection: close\r\n" +
      "\r\nhello",
  );
  const head = parseResponseHead(raw);
  assert.equal(head.status, 200);
  assert.equal(head.contentLength, 5);
  assert.equal(head.chunked, false);
  assert.deepEqual(head.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.equal(head.headers.get("connection"), null, "hop-by-hop headers are dropped");
  assert.equal(text(head.rest), "hello");
});

test("waits for the full head, and reports 204 as bodyless", () => {
  assert.equal(parseResponseHead(bytes("HTTP/1.1 200 OK\r\nX: 1\r\n")), null);
  assert.equal(parseResponseHead(bytes("HTTP/1.1 204 No Content\r\n\r\n")).contentLength, 0);
});

test("de-chunks a body fed one byte at a time", () => {
  const decoder = new ChunkedDecoder();
  const body = "4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
  let out = "";
  for (const byte of bytes(body)) out += text(decoder.feed(new Uint8Array([byte])));
  assert.equal(out, "Wikipedia");
  assert.equal(decoder.done, true);
});

test("serializes a request with a length and without hop-by-hop headers", () => {
  const url = new URL("https://demo.example.com/echo?q=1");
  const headers = new Headers({ "user-agent": "curl", connection: "keep-alive" });
  const out = text(serializeRequest("POST", url, headers, "demo.example.com", 11));
  assert.match(out, /^POST \/echo\?q=1 HTTP\/1\.1\r\n/);
  assert.match(out, /\r\nHost: demo\.example\.com\r\n/);
  assert.match(out, /\r\nUser-Agent: curl\r\n/i);
  assert.match(out, /\r\nContent-Length: 11\r\n/);
  assert.doesNotMatch(out, /keep-alive/i);
  assert.ok(out.endsWith("\r\n\r\n"));
});

test("forces identity encoding on the request to the origin", () => {
  const url = new URL("https://demo.example.com/");
  const headers = new Headers({ "accept-encoding": "gzip, deflate, br" });
  const out = text(serializeRequest("GET", url, headers, "demo.example.com", 0));
  assert.match(out, /\r\nAccept-Encoding: identity\r\n/);
  assert.doesNotMatch(out, /gzip/i, "the visitor's accept-encoding must not reach the origin");
});

test("strips Content-Encoding from the response and reports it separately", () => {
  const head = parseResponseHead(
    bytes("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 9\r\n\r\n"),
  );
  assert.equal(head.contentEncoding, "gzip");
  assert.equal(head.headers.get("content-encoding"), null);
});

test("masks outgoing websocket frames and round-trips through the decoder", () => {
  const payload = bytes("hot reload");
  const frame = encodeWsFrame(WS_OP.text, payload);
  assert.equal(frame[0], 0x80 | WS_OP.text, "FIN set, text opcode");
  assert.ok(frame[1] & 0x80, "client frames must be masked");
  assert.notDeepEqual(frame.subarray(6), payload, "payload must not be sent in the clear");

  // Decode it back by clearing the mask bit path: the decoder unmasks for us.
  const decoded = new WsFrameDecoder().push(frame);
  assert.equal(decoded.length, 1);
  assert.equal(text(decoded[0].payload), "hot reload");
  assert.equal(decoded[0].opcode, WS_OP.text);
  assert.equal(decoded[0].fin, true);
});

test("decodes each websocket payload length form", () => {
  for (const size of [10, 200, 70000]) {
    const payload = new Uint8Array(size).fill(65);
    const frames = new WsFrameDecoder().push(encodeWsFrame(WS_OP.binary, payload));
    assert.equal(frames.length, 1, `size ${size}`);
    assert.equal(frames[0].payload.length, size, `size ${size}`);
  }
});

test("reassembles fragmented frames and splits frames across chunks", () => {
  // Unmasked server->client frames, fragmented: "Wiki" + "pedia"
  const a = new Uint8Array([0x01, 0x04, ...bytes("Wiki")]); // text, FIN=0
  const b = new Uint8Array([0x80, 0x05, ...bytes("pedia")]); // cont, FIN=1
  const decoder = new WsFrameDecoder();
  const stream = new Uint8Array([...a, ...b]);
  const out = [];
  for (const byte of stream) out.push(...decoder.push(new Uint8Array([byte])));
  assert.equal(out.length, 2);
  assert.equal(out[0].fin, false);
  assert.equal(text(out[0].payload), "Wiki");
  assert.equal(out[1].opcode, WS_OP.cont);
  assert.equal(text(out[1].payload), "pedia");
});

test("builds an upgrade request without extensions", () => {
  const url = new URL("https://demo.example.com/_next/webpack-hmr");
  const headers = new Headers({
    "sec-websocket-extensions": "permessage-deflate",
    "sec-websocket-protocol": "hmr",
    "sec-websocket-key": "visitorkey",
    origin: "https://demo.example.com",
  });
  const out = text(serializeUpgradeRequest(url, headers, "demo.example.com", "ABC123"));
  assert.match(out, /^GET \/_next\/webpack-hmr HTTP\/1\.1\r\n/);
  assert.match(out, /\r\nUpgrade: websocket\r\n/);
  assert.match(out, /\r\nSec-WebSocket-Key: ABC123\r\n/);
  assert.match(out, /\r\nsec-websocket-protocol: hmr\r\n/i);
  assert.match(out, /\r\norigin: https:\/\/demo\.example\.com\r\n/i);
  assert.doesNotMatch(out, /permessage-deflate/, "extensions must not be offered");
  assert.doesNotMatch(out, /visitorkey/, "the visitor's key must not be reused");
});
