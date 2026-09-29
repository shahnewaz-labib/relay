package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"relay/internal/protocol"
	"relay/internal/wire"
)

type tunnelFixture struct {
	server *httptest.Server
	client *http.Client
	reg    *registry
	origin string
}

func newTunnelFixture(t *testing.T) *tunnelFixture {
	t.Helper()
	oldDomain, oldToken, oldURL := *rootDomain, *authToken, *publicURL
	*rootDomain, *authToken = "relay.test", "test-secret"
	t.Cleanup(func() { *rootDomain, *authToken, *publicURL = oldDomain, oldToken, oldURL })
	reg := newRegistry()
	var handlers sync.WaitGroup
	h := serverHandler(acceptOpts{reg: reg, publicHTTPS: true})
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlers.Add(1)
		defer handlers.Done()
		h.ServeHTTP(w, r)
	}))
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	*publicURL = "https://relay.test:" + port
	transport := srv.Client().Transport.(*http.Transport).Clone()
	// TLS still verifies the fixture certificate's IP SAN; only the socket
	// destination and TLS name change, while Host remains the public hostname.
	transport.TLSClientConfig.ServerName = "127.0.0.1"
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	t.Cleanup(func() { transport.CloseIdleConnections(); srv.Close(); handlers.Wait() })
	return &tunnelFixture{server: srv, client: client, reg: reg, origin: *publicURL}
}

func (f *tunnelFixture) connect(t *testing.T, name, origin string) (protocol.AuthAck, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	ws, _, err := websocket.Dial(ctx, f.origin+protocol.ConnectPath, &websocket.DialOptions{
		HTTPClient: f.client, HTTPHeader: http.Header{"Authorization": {"Bearer test-secret"}}, Subprotocols: []string{protocol.Version},
	})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	wc := wire.New(websocket.NetConn(ctx, ws, websocket.MessageBinary))
	done := make(chan struct{})
	var once sync.Once
	closePeer := func() { once.Do(func() { cancel(); ws.CloseNow(); wc.Close(); <-done }) }
	auth, _ := json.Marshal(protocol.Auth{Name: name, Token: "test-secret"})
	if err := wc.Control(wire.Auth, auth); err != nil {
		t.Fatal(err)
	}
	event := <-wc.Events()
	var ack protocol.AuthAck
	if event.Type == wire.AuthAck {
		if err := json.Unmarshal(event.Body, &ack); err != nil {
			t.Fatal(err)
		}
	} else {
		ack.URL = "rejected:" + string(event.Body)
	}
	go func() {
		defer close(done)
		for ev := range wc.Events() {
			if ev.Type != wire.Syn {
				continue
			}
			st, ok := wc.Lookup(ev.ID)
			if !ok {
				continue
			}
			go func() {
				defer st.Close()
				conn, err := net.DialTimeout("tcp", origin, time.Second)
				if err != nil {
					return
				}
				defer conn.Close()
				go io.Copy(conn, st)
				io.Copy(st, conn)
			}()
		}
	}()
	t.Cleanup(closePeer)
	return ack, closePeer
}

func TestVisitorURLUsesExternalSchemeAndPort(t *testing.T) {
	oldDomain, oldURL, oldAddr, oldCert, oldHTTPS := *rootDomain, *publicURL, *publicAddr, *publicCert, *autoHTTPS
	defer func() {
		*rootDomain, *publicURL, *publicAddr, *publicCert, *autoHTTPS = oldDomain, oldURL, oldAddr, oldCert, oldHTTPS
	}()
	*rootDomain, *publicURL, *publicAddr, *publicCert, *autoHTTPS = "relay.test", "", ":8080", "", false
	ack := protocol.AuthAck{Domain: "relay.test", Scheme: "http"}
	if got := visitorURL("demo", ack); got != "http://demo.relay.test:8080" {
		t.Fatal(got)
	}
	*publicURL = "https://relay.test"
	if got := visitorURL("demo", ack); got != "https://demo.relay.test" {
		t.Fatal(got)
	}
	*publicURL = "https://relay.test:8443"
	if got := visitorURL("demo", ack); got != "https://demo.relay.test:8443" {
		t.Fatal(got)
	}
	ack = protocol.AuthAck{Host: "127.0.0.1", Port: "8081", Scheme: "https"}
	if got := visitorURL("demo", ack); got != "http://127.0.0.1:8081" {
		t.Fatal(got)
	}
}

func TestWebSocketTunnelHTTPAndUpgrade(t *testing.T) {
	f := newTunnelFixture(t)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			ws, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer ws.CloseNow()
			kind, b, err := ws.Read(r.Context())
			if err == nil {
				_ = ws.Write(r.Context(), kind, b)
			}
			return
		}
		w.Header().Add("Set-Cookie", "a=1")
		w.Header().Add("Set-Cookie", "b=2")
		w.Header().Set("X-Received-Path", r.URL.RequestURI())
		io.Copy(w, r.Body)
	}))
	defer origin.Close()
	ack, _ := f.connect(t, "demo", origin.Listener.Addr().String())
	wantURL := strings.Replace(f.origin, "relay.test", "demo.relay.test", 1)
	if ack.URL != wantURL {
		t.Fatalf("URL = %q, want %q", ack.URL, wantURL)
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body := bytes.Repeat([]byte{0, 1, 2, 255}, 100_000)
			resp, err := f.client.Post(ack.URL+"/echo?q=1", "application/octet-stream", bytes.NewReader(body))
			if err != nil {
				t.Error(err)
				return
			}
			defer resp.Body.Close()
			got, err := io.ReadAll(resp.Body)
			if err != nil || !bytes.Equal(got, body) || resp.StatusCode != 200 {
				t.Errorf("echo status=%d, bytes=%d, err=%v", resp.StatusCode, len(got), err)
			}
			if len(resp.Header.Values("Set-Cookie")) != 2 || resp.Header.Get("X-Received-Path") != "/echo?q=1" {
				t.Error("lost headers or query")
			}
		}()
	}
	wg.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, ack.URL+"/ws", &websocket.DialOptions{HTTPClient: f.client})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err := ws.Write(ctx, websocket.MessageText, []byte("hot reload")); err != nil {
		t.Fatal(err)
	}
	_, msg, err := ws.Read(ctx)
	if err != nil || string(msg) != "hot reload" {
		t.Fatalf("upgrade echo = %q, %v", msg, err)
	}
}

func TestWebSocketAuthenticationNamesAndCertificatePolicy(t *testing.T) {
	f := newTunnelFixture(t)
	resp, err := f.client.Get(f.origin + protocol.CheckPath)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("unauthenticated check: %d", resp.StatusCode)
	}
	_, resp, err = websocket.Dial(context.Background(), f.origin+protocol.ConnectPath, &websocket.DialOptions{HTTPClient: f.client, Subprotocols: []string{protocol.Version}})
	if err == nil || resp == nil || resp.StatusCode != 401 {
		t.Fatalf("unauthenticated upgrade: %v, %v", resp, err)
	}
	req, _ := http.NewRequest("GET", f.origin+protocol.CheckPath, nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	resp, err = f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("authenticated check: %d", resp.StatusCode)
	}
	policy := certificatePolicy(f.reg)
	if err := policy(context.Background(), "relay.test"); err != nil {
		t.Fatal(err)
	}
	if err := policy(context.Background(), "demo.relay.test"); err == nil {
		t.Fatal("issued for unregistered name")
	}
	ack, closeFirst := f.connect(t, "demo", "")
	if !strings.HasPrefix(ack.URL, "https://") {
		t.Fatal(ack.URL)
	}
	if err := policy(context.Background(), "demo.relay.test"); err != nil {
		t.Fatal(err)
	}
	duplicate, _ := f.connect(t, "demo", "")
	if !strings.HasPrefix(duplicate.URL, "rejected:") {
		t.Fatal("duplicate name accepted")
	}
	closeFirst()
	deadline := time.Now().Add(2 * time.Second)
	for f.reg.has("demo") && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if f.reg.has("demo") {
		t.Fatal("name not released after disconnect")
	}
	if err := policy(context.Background(), "demo.relay.test"); err == nil {
		t.Fatal("issued for disconnected name")
	}
	ack, _ = f.connect(t, "demo", "")
	if !strings.HasPrefix(ack.URL, "https://") {
		t.Fatal("name cannot be reclaimed: " + ack.URL)
	}
}
