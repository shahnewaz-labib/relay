import assert from "node:assert/strict";
import test from "node:test";

import {
  ChunkedDecoder,
  FrameParser,
  T,
  encodeData,
  encodeFrame,
  parseResponseHead,
  serializeRequest,
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
