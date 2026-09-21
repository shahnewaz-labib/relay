// Package wire implements a tiny stream-multiplexing protocol over a single
// net.Conn. It exists so relay can serve many visitors concurrently over ONE
// outbound tunnel connection, instead of burning one parked TCP connection
// per visitor.
//
// Wire format — every frame is:
//
//	[type: 1 byte][streamID: 8 bytes, big-endian][length: 4 bytes, big-endian]
//	[payload: length bytes]
//
// Frame types:
//
//	Syn      open stream with this ID (sent by the opener, conventionally relayd)
//	Data     payload bytes belonging to stream ID
//	Fin      sender will send nothing more on stream ID
//	Ping     keepalive probe (answered automatically with Pong)
//	Pong     reply to Ping
//	Auth     control frame (payload opaque to wire — used by relay/relayd)
//	AuthAck  control ack
//	Reject   control rejection (payload is a human-readable reason)
//	Dead     internal only: emitted as an Event when the underlying conn dies
//
// Deliberate simplifications (documented trade-offs, see README):
//   - Per-stream receive buffers are unbounded: a fast stream can grow memory
//     if the local consumer stalls. Real muxers (yamux, QUIC) use windowed
//     flow control; that is future work.
//   - Only ONE side (the relay) opens streams today, so IDs never collide.
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

type FrameType uint8

const (
	Syn     FrameType = iota + 1 // open a stream
	Data                         // stream payload
	Fin                          // sender done with stream
	Ping                         // keepalive probe
	Pong                         // keepalive reply
	Auth                         // authenticate a tunnel connection
	AuthAck                      // auth succeeded
	Reject                       // request refused (payload: reason)
	Dead                         // pseudo-type: the conn itself died
)

const (
	headerSize = 13 // 1 type + 8 id + 4 length
	maxPayload = 1 << 20
	chunkSize  = 1 << 16 // outbound DATA frames are split to at most this
)

var errClosed = errors.New("wire: connection closed")

// Event is something the application needs to know about, delivered in order
// on a single channel. DATA never appears here — it lands directly in the
// target Stream's buffer.
type Event struct {
	Type FrameType
	ID   uint64
	Body []byte
}

// Conn multiplexes streams over one net.Conn.
type Conn struct {
	nc     net.Conn
	events chan Event

	wmu sync.Mutex // serializes whole-frame writes

	nextID uint64 // used only by the designated stream opener

	mu      sync.Mutex
	streams map[uint64]*Stream

	evmu    sync.Mutex
	evClose bool

	dead      atomic.Bool
	closeOnce sync.Once

	stopped    chan struct{} // closed by shutdown; wakes the pinger
	kaEnabled  bool
	kaInterval time.Duration // send Ping this often...
	kaTimeout  time.Duration // ...and die if nothing arrives for this long
}

// Keepalive defaults used by both relay binaries.
const (
	PingInterval = 10 * time.Second // send Ping this often
	PingTimeout  = 30 * time.Second // die if no frame arrives for this long
)

// New wraps nc and starts the frame read loop. The caller MUST drain Events()
// (in a dedicated goroutine) for the lifetime of the connection.
func New(nc net.Conn, opts ...Option) *Conn {
	c := &Conn{
		nc:      nc,
		events:  make(chan Event, 256),
		streams: make(map[uint64]*Stream),
		stopped: make(chan struct{}),
	}
	for _, opt := range opts {
		opt(c)
	}
	go c.readLoop() // started last: sees fully-configured state, no races
	return c
}

// Option configures a Conn at construction time.
type Option func(*Conn)

// WithKeepalive starts a Ping ticker and arms read deadlines: if no frame
// (Pings included) arrives within timeout, the connection shuts down. Both
// sides of a tunnel should enable it — NAT tables silently reap idle conns.
// Must be passed to New; mutating a live conn would be racy.
func WithKeepalive(interval, timeout time.Duration) Option {
	return func(c *Conn) {
		c.kaEnabled = true
		c.kaInterval = interval
		c.kaTimeout = timeout
		go func() {
			t := time.NewTicker(interval)
			defer t.Stop()
			for {
				select {
				case <-c.stopped:
					return
				case <-t.C:
					if err := c.writeFrame(Ping, 0, nil); err != nil {
						return // readLoop will notice the corpse
					}
				}
			}
		}()
	}
}

// Events returns the ordered event stream. Closed when the conn dies.
func (c *Conn) Events() <-chan Event { return c.events }

// Dead reports whether the underlying connection has failed.
func (c *Conn) Dead() bool { return c.dead.Load() }

// Open creates a new outgoing stream. Only the designated opener side may
// call this (see package comment).
func (c *Conn) Open() (*Stream, error) {
	if c.dead.Load() {
		return nil, errClosed
	}
	id := atomic.AddUint64(&c.nextID, 1)
	s := newStream(c, id)
	c.mu.Lock()
	c.streams[id] = s
	c.mu.Unlock()
	if err := c.writeFrame(Syn, id, nil); err != nil {
		c.unregister(id)
		return nil, err
	}
	return s, nil
}

// Lookup returns the locally-created stream with this ID, if any.
func (c *Conn) Lookup(id uint64) (*Stream, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.streams[id]
	return s, ok
}

// Control sends a control frame (Auth, AuthAck, Reject, Ping, ...) that has no
// stream context.
func (c *Conn) Control(t FrameType, body []byte) error {
	return c.writeFrame(t, 0, body)
}

// Close tears down the connection and every stream on it.
func (c *Conn) Close() error {
	c.closeOnce.Do(func() { go c.shutdown(errors.New("wire: closed locally")) })
	return nil
}

// ---- internals ----

func (c *Conn) writeFrame(t FrameType, id uint64, body []byte) error {
	if len(body) > maxPayload {
		return fmt.Errorf("wire: payload %d exceeds %d", len(body), maxPayload)
	}
	hdr := make([]byte, headerSize)
	hdr[0] = byte(t)
	binary.BigEndian.PutUint64(hdr[1:], id)
	binary.BigEndian.PutUint32(hdr[9:], uint32(len(body)))

	c.wmu.Lock()
	defer c.wmu.Unlock()
	if _, err := c.nc.Write(hdr); err != nil {
		return err
	}
	if len(body) > 0 {
		if _, err := c.nc.Write(body); err != nil {
			return err
		}
	}
	return nil
}

func (c *Conn) readLoop() {
	var err error
	for {
		if c.kaEnabled {
			c.nc.SetReadDeadline(time.Now().Add(c.kaTimeout))
		}
		hdr := make([]byte, headerSize)
		if _, err = io.ReadFull(c.nc, hdr); err != nil {
			break
		}
		t := FrameType(hdr[0])
		id := binary.BigEndian.Uint64(hdr[1:])
		n := binary.BigEndian.Uint32(hdr[9:])
		if t < Syn || t > Reject || n > maxPayload {
			err = fmt.Errorf("wire: bad frame type=%d len=%d", t, n)
			break
		}
		var body []byte
		if n > 0 {
			body = make([]byte, n)
			if _, err = io.ReadFull(c.nc, body); err != nil {
				break
			}
		}

		switch t {
		case Syn:
			s := newStream(c, id)
			c.mu.Lock()
			c.streams[id] = s
			c.mu.Unlock()
			c.pushEvent(Event{Type: Syn, ID: id})
		case Data:
			if s, ok := c.Lookup(id); ok {
				s.push(body)
			} // else: late data for a stream we already closed — ignore
		case Fin:
			if s, ok := c.Lookup(id); ok {
				s.closeRead()
			}
			c.pushEvent(Event{Type: Fin, ID: id})
		case Ping:
			// Answer asynchronously: writing from inside the readLoop can
			// deadlock on synchronous transports (both loops stuck writing
			// Pongs, neither reading). Pong ordering doesn't matter.
			go func() { _ = c.writeFrame(Pong, 0, nil) }()
		case Pong:
			// keepalive satisfied by the fact a frame arrived
		default: // Auth, AuthAck, Reject — application-level
			c.pushEvent(Event{Type: t, Body: body})
		}
	}
	c.closeOnce.Do(func() { go c.shutdown(err) })
}

func (c *Conn) shutdown(cause error) {
	c.dead.Store(true)
	close(c.stopped)
	c.mu.Lock()
	for _, s := range c.streams {
		s.closeRead()
	}
	c.mu.Unlock()

	c.evmu.Lock()
	closedAlready := c.evClose
	c.evClose = true
	c.evmu.Unlock()
	if !closedAlready {
		if cause != nil {
			c.events <- Event{Type: Dead, Body: []byte(cause.Error())}
		}
		close(c.events)
	}
	c.nc.Close()
}

func (c *Conn) pushEvent(e Event) {
	c.evmu.Lock()
	defer c.evmu.Unlock()
	if c.evClose {
		return
	}
	c.events <- e // blocking: app must keep draining (see package docs)
}

func (c *Conn) unregister(id uint64) {
	c.mu.Lock()
	delete(c.streams, id)
	c.mu.Unlock()
}

// Stream is one multiplexed, ordered, bidirectional byte pipe. It satisfies
// enough of net.Conn to be usable with io.Copy and http.Transport custom
// dialers. Deadline methods are accepted and ignored (future work).
type Stream struct {
	id   uint64
	conn *Conn

	mu   sync.Mutex
	cond *sync.Cond
	buf  []byte
	eof  bool

	finSent atomic.Bool
}

func newStream(c *Conn, id uint64) *Stream {
	s := &Stream{id: id, conn: c}
	s.cond = sync.NewCond(&s.mu)
	return s
}

func (s *Stream) ID() uint64 { return s.id }

func (s *Stream) Read(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for len(s.buf) == 0 && !s.eof {
		s.cond.Wait()
	}
	if len(s.buf) > 0 {
		n := copy(p, s.buf)
		s.buf = s.buf[n:]
		return n, nil
	}
	return 0, io.EOF
}

func (s *Stream) Write(p []byte) (int, error) {
	if s.conn.dead.Load() || s.finSent.Load() {
		return 0, errClosed
	}
	total := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > chunkSize {
			chunk = chunk[:chunkSize]
		}
		if err := s.conn.writeFrame(Data, s.id, chunk); err != nil {
			return total, err
		}
		total += len(chunk)
		p = p[len(chunk):]
	}
	return total, nil
}

// Close sends FIN (once) and releases local readers with EOF.
func (s *Stream) Close() error {
	if s.finSent.CompareAndSwap(false, true) {
		_ = s.conn.writeFrame(Fin, s.id, nil)
		s.conn.unregister(s.id)
	}
	s.closeRead()
	return nil
}

func (s *Stream) push(b []byte) {
	s.mu.Lock()
	s.buf = append(s.buf, b...)
	s.cond.Signal()
	s.mu.Unlock()
}

func (s *Stream) closeRead() {
	s.mu.Lock()
	s.eof = true
	s.cond.Signal()
	s.mu.Unlock()
}

// net.Conn compatibility shims ---------------------------------------------
// Deadlines are accepted and ignored for now; plumbing them end-to-end is
// roadmap work. HTTP/1.1 proxying does not require them.

func (s *Stream) LocalAddr() net.Addr                { return s.conn.nc.LocalAddr() }
func (s *Stream) RemoteAddr() net.Addr               { return s.conn.nc.RemoteAddr() }
func (s *Stream) SetDeadline(t time.Time) error      { return nil }
func (s *Stream) SetReadDeadline(t time.Time) error  { return nil }
func (s *Stream) SetWriteDeadline(t time.Time) error { return nil }
