// Command relay is the client half: run it NEXT TO your local service, on the
// machine WITHOUT a public address.
//
// It dials OUT to relayd, authenticates with a token under a chosen name
// (becoming e.g. alice.example.com), then binds every incoming stream to a
// fresh connection to the local service.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"relay/internal/protocol"
	"relay/internal/wire"
)

var (
	relay     = flag.String("relay", "localhost:7000", "address of relayd's tunnel port (host:port)")
	localAddr = flag.String("local", "localhost:8000", "local service to expose")
	name      = flag.String("name", "", "tunnel name (default: random; machine hostname in raw TCP mode)")
	token     = flag.String("token", "", "auth token expected by relayd (required)")
	retryWait = flag.Duration("retry-wait", 2*time.Second, "pause between relay dial attempts")

	useTLS     = flag.Bool("tls", false, "dial the relay over TLS")
	caFile     = flag.String("ca", "", "CA bundle (PEM) to verify the relay; empty = system roots")
	tlsName    = flag.String("tls-name", "", "server name for TLS verification (default: host part of --relay)")
	serverURL  = flag.String("server", "", "HTTP(S) Relay server (default: saved by relay setup)")
	jsonOutput = flag.Bool("json", false, "print connection events as JSON")
)

// Authentication and URL announcements are shared with all backends.
type authMsg = protocol.Auth
type authAckMsg = protocol.AuthAck

func main() {
	if len(os.Args) > 1 && os.Args[1] == "setup" {
		if err := setup(os.Args[2:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return
			}
			log.Fatal(err)
		}
		return
	}
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "Usage: relay <port> [flags]\n       relay setup --server https://tunnels.example.com\n\nFlags:")
		flag.PrintDefaults()
	}
	flag.CommandLine.Parse(commandArgs(os.Args[1:]))
	if flag.NArg() > 1 {
		log.Fatal("usage: relay <port> [flags]")
	}
	if flag.NArg() == 1 {
		var err error
		*localAddr, err = localPort(flag.Arg(0))
		if err != nil {
			log.Fatal(err)
		}
	}
	if *retryWait <= 0 {
		log.Fatal("--retry-wait must be positive")
	}
	explicitRelay := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "relay" {
			explicitRelay = true
		}
	})
	if explicitRelay && *serverURL != "" {
		log.Fatal("use either --server or --relay")
	}
	var cfg clientConfig
	if !explicitRelay {
		var err error
		cfg, err = loadConfig()
		if err != nil {
			log.Fatal("read configuration: ", err)
		}
		if *serverURL == "" {
			*serverURL = cfg.Server
		}
		// Never send a saved credential to a different explicit server.
		if *serverURL != "" {
			u, err := protocol.ServerURL(*serverURL)
			if err != nil {
				log.Fatal(err)
			}
			*serverURL = u.String()
			if cfg.Server != *serverURL {
				cfg.Token = ""
			}
		}
	}
	if *token == "" {
		*token = os.Getenv("RELAY_TOKEN")
	}
	if *token == "" {
		*token = cfg.Token
	}
	if flag.NArg() == 1 && *serverURL == "" && !explicitRelay {
		log.Fatal("no server configured: run relay setup --server https://tunnels.example.com")
	}
	if *token == "" {
		log.Fatal("no token: run relay setup, pass --token, or set RELAY_TOKEN")
	}
	if *name == "" {
		if *serverURL != "" {
			var err error
			*name, err = protocol.RandomName()
			if err != nil {
				log.Fatal(err)
			}
		} else {
			h, err := os.Hostname()
			if err != nil {
				log.Fatal("--name is required (hostname unavailable): ", err)
			}
			*name = sanitize(h)
		}
	}
	if !protocol.ValidName(*name) {
		log.Fatal("invalid tunnel name: use 1–63 lowercase letters, digits, or internal hyphens")
	}
	if *serverURL != "" {
		conn, err := net.DialTimeout("tcp", *localAddr, 5*time.Second)
		if err != nil {
			log.Fatal("local service is unreachable: ", err)
		}
		conn.Close()
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Exponential backoff with jitter. The counter resets only when the
	// relay ACKs our auth — a dial that succeeds but then dies instantly
	// must not let us hammer the server.
	const maxWait = 30 * time.Second
	wait := *retryWait
	for {
		authed := false
		runOnce(ctx, func() { authed = true })
		if ctx.Err() != nil {
			return
		}
		if authed {
			wait = *retryWait
		} else {
			wait *= 2
			if wait > maxWait {
				wait = maxWait
			}
		}
		jitter := time.Duration(rand.Int64N(max(1, int64(wait)/4)))
		log.Printf("tunnel gone; reconnecting in ~%s", wait+jitter)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait + jitter):
		}
	}
}

// runOnce maintains one multiplexed tunnel until it dies, calling markAuth
// once the relay accepts our credentials.
func runOnce(ctx context.Context, markAuth func()) {
	nc, err := dialRelay(ctx)
	if err != nil {
		log.Printf("connect failed: %v", err)
		return
	}
	defer nc.Close()
	stop := context.AfterFunc(ctx, func() { nc.Close() })
	defer stop()

	wc := wire.New(nc, wire.WithKeepalive(wire.PingInterval, wire.PingTimeout))
	defer wc.Close()

	auth, _ := json.Marshal(authMsg{Name: *name, Token: *token})
	if err := wc.Control(wire.Auth, auth); err != nil {
		log.Printf("auth send failed: %v", err)
		return
	}

	for ev := range wc.Events() {
		switch ev.Type {
		case wire.AuthAck:
			var ack authAckMsg
			if err := json.Unmarshal(ev.Body, &ack); err != nil {
				log.Printf("malformed auth ack: %v", err)
				return
			}
			markAuth()
			if *serverURL != "" && ack.URL != "" {
				if err := checkPublicURL(ctx, ack.URL); err != nil {
					log.Printf("public URL not ready: %v", err)
					return
				}
			}
			if wc.Dead() || ctx.Err() != nil {
				return
			}
			printVisitorURL(ack)

		case wire.Reject:
			// A rejection will not heal by retrying — fail loudly instead.
			log.Fatalf("relay rejected us: %s", string(ev.Body))

		case wire.Syn:
			go bind(wc, ev.ID)

		case wire.Fin:
			if s, ok := wc.Lookup(ev.ID); ok {
				s.Close() // release local readers/writers promptly
			}
		}
	}
}

// printVisitorURL renders the best visitor URL the relay's ack allows.
// Priority: canonical URL > legacy domain > mapped port > generic hint.
func printVisitorURL(ack authAckMsg) {
	if ack.URL != "" {
		if *jsonOutput {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "ready", "url": ack.URL, "name": *name, "local": *localAddr})
		} else {
			fmt.Printf("\n  %s → %s\n\n", ack.URL, *localAddr)
		}
		return
	}
	scheme := ack.Scheme
	if scheme == "" {
		scheme = "http"
	}
	switch {
	case ack.Domain != "":
		fmt.Printf("\n  Visitors can open:\n\n      %s://%s.%s\n\n",
			scheme, *name, ack.Domain)
	case ack.Host != "" && ack.Port != "":
		fmt.Printf("\n  Visitors can open:\n\n      %s://%s:%s\n\n",
			scheme, ack.Host, ack.Port)
	case ack.Host != "":
		fmt.Printf("\n  Tunnel is up. Visitors need Host %q on the relay's public port.\n\n", *name)
	default:
		log.Printf("tunnel live: name=%q -> %s", *name, *localAddr)
	}
}

// dialRelay uses WebSocket for server origins, or the legacy TCP/TLS transport.
func dialRelay(ctx context.Context) (net.Conn, error) {
	if *serverURL != "" {
		u, err := protocol.ServerURL(*serverURL)
		if err != nil {
			return nil, err
		}
		u.Path = protocol.ConnectPath
		if u.Scheme == "https" {
			u.Scheme = "wss"
		} else {
			u.Scheme = "ws"
		}
		cfg, err := clientTLSConfig()
		if err != nil {
			return nil, err
		}
		transport := &http.Transport{TLSClientConfig: cfg, Proxy: http.ProxyFromEnvironment}
		defer transport.CloseIdleConnections()
		dialCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		ws, resp, err := websocket.Dial(dialCtx, u.String(), &websocket.DialOptions{
			HTTPClient:   &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
			HTTPHeader:   http.Header{"Authorization": {"Bearer " + *token}},
			Subprotocols: []string{protocol.Version},
		})
		if err != nil {
			if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
				log.Fatal("server rejected credentials; check RELAY_TOKEN or run relay setup again")
			}
			return nil, err
		}
		if ws.Subprotocol() != protocol.Version {
			ws.CloseNow()
			return nil, errors.New("server does not support relay/1")
		}
		return websocket.NetConn(ctx, ws, websocket.MessageBinary), nil
	}
	if !*useTLS {
		d := net.Dialer{Timeout: 5 * time.Second}
		return d.DialContext(ctx, "tcp", *relay)
	}
	host, _, err := net.SplitHostPort(*relay)
	if err != nil {
		host = *relay
	}
	sni := *tlsName
	if sni == "" {
		sni = host
	}
	cfg, err := clientTLSConfig()
	if err != nil {
		return nil, err
	}
	cfg.ServerName = sni
	cfg.NextProtos = []string{protocol.Version}
	if *caFile == "" && net.ParseIP(sni) != nil {
		return nil, errors.New("dialing an IP over TLS needs verification: pass --tls-name or --ca with a matching cert")
	}
	d := tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: cfg}
	return d.DialContext(ctx, "tcp", *relay)
}

func clientTLSConfig() (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: *tlsName}
	if *caFile != "" {
		pemBytes, err := os.ReadFile(*caFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pemBytes) {
			return nil, errors.New("--ca file contains no PEM certificates")
		}
		cfg.RootCAs = pool
	}
	return cfg, nil
}

// Check DNS/TLS reachability without sending a request to the user's app.
func checkPublicURL(ctx context.Context, value string) error {
	u, err := protocol.ServerURL(value)
	if err != nil {
		return err
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	addr := net.JoinHostPort(u.Hostname(), port)
	checkCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	d := &net.Dialer{Timeout: 60 * time.Second}
	var conn net.Conn
	if u.Scheme == "https" {
		cfg, cfgErr := clientTLSConfig()
		if cfgErr != nil {
			return cfgErr
		}
		cfg.ServerName = u.Hostname()
		conn, err = (&tls.Dialer{NetDialer: d, Config: cfg}).DialContext(checkCtx, "tcp", addr)
	} else {
		conn, err = d.DialContext(checkCtx, "tcp", addr)
	}
	if err != nil {
		return err
	}
	return conn.Close()
}

// bind connects one incoming stream to the local service and pumps bytes
// both ways until either side finishes.
func bind(wc *wire.Conn, id uint64) {
	st, ok := wc.Lookup(id)
	if !ok {
		return
	}
	svc, err := net.DialTimeout("tcp", *localAddr, 5*time.Second)
	if err != nil {
		log.Printf("stream %d: local service %s unreachable: %v", id, *localAddr, err)
		st.Close()
		return
	}

	log.Printf("stream %d -> %s", id, *localAddr)

	go func() {
		io.Copy(svc, st) // request bytes → local service
		// The request side is finished. Why this is not a full close: the
		// origin still owes us a response, and closing svc here truncates it.
		// Half-close instead, so the origin sees EOF on its read side and can
		// still reply. If the tunnel itself died there is no response coming,
		// so tear everything down — that is what releases a local origin
		// waiting indefinitely, such as an idle WebSocket.
		if wc.Dead() {
			svc.Close()
			st.Close()
			return
		}
		if cw, ok := svc.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}()
	io.Copy(st, svc) // response bytes → visitor
	st.Close()
	svc.Close()
}

func sanitize(s string) string {
	s = strings.ToLower(s)
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			return r
		default:
			return -1
		}
	}, strings.ReplaceAll(s, " ", "-"))
	return strings.Trim(s, "-")
}
