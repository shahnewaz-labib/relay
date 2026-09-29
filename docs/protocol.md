# Relay protocol

Both deployment backends are intended to implement this contract. The native
Go VPS backend implements it today; the Workers/Durable Objects backend is
future work. Relay owns this protocol and the forwarding implementation.

## Endpoints

The server origin is the base domain, e.g. `https://tunnels.example.com`.

- `GET /_relay/check`: requires `Authorization: Bearer <token>`; returns
  `{"protocol":"relay/1"}` on success, 401 on invalid credentials.
- `GET /_relay/connect`: the same authorization header, WebSocket upgrade,
  and `Sec-WebSocket-Protocol: relay/1` are required. The chosen subprotocol
  must be echoed by the server.
- Visitors use `https://<name>.tunnels.example.com`. Control endpoints are
  only reserved on the base domain, not on visitor subdomains.

TLS is verified by the client. HTTP/WS is available for local testing.
The token authenticates tunnel creation, not visitors to the public URL.

## Framing

WebSocket binary messages carry a byte stream using `internal/wire`:

```text
[type: u8][stream ID: u64 big-endian][payload length: u32 big-endian][payload]
```

Frames may span multiple WebSocket messages, or share a message. An
implementation must parse the stream rather than assume a message is a frame.
Payloads are limited to 1 MiB; writers split data into 64 KiB chunks.

| Type | Value | Payload |
| --- | --- | --- |
| Syn | 1 | Opens a stream; server is the only opener |
| Data | 2 | Bytes for the stream |
| Fin | 3 | Stream end |
| Ping | 4 | Connection keepalive |
| Pong | 5 | Keepalive response |
| Auth | 6 | JSON `{ "name": "demo", "token": "..." }` |
| AuthAck | 7 | JSON containing the canonical `url` and legacy `domain`, `host`, `port`, `scheme` fields |
| Reject | 8 | Human-readable rejection reason |

Control frames use stream ID 0. After the upgrade, the client sends Auth.
The server accepts valid credentials and a DNS-label name, reserves that
name exclusively, and replies with AuthAck. A duplicate live name is rejected.
The client retains its generated name across reconnects. Closing the
connection unregisters its names and closes its streams.

## HTTP forwarding

For each visitor request, the native server opens a stream and writes an
HTTP/1.1 request into it. The client binds the stream to the configured local
TCP service. Responses flow back through the same stream. HTTP upgrades use
that stream bidirectionally, allowing WebSockets and development-server HMR.

This is a byte-stream protocol today, not the HTTP-metadata protocol proposed
during early planning. A Workers backend needs an HTTP/1.1 bridge, or a
versioned HTTP-aware successor negotiated by both implementations. That work
must include bounded flow control and hibernation-compatible heartbeats;
wrapping the existing stream in a DO alone is not sufficient. The client
configuration stores a server origin rather than a provider name so backend
selection stays independent of the everyday command.
