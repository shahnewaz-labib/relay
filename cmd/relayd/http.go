package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/acme/autocert"

	"relay/internal/protocol"
)

func serverOrigin() string {
	if *publicURL != "" {
		return *publicURL
	}
	scheme := "http"
	if *publicCert != "" || *autoHTTPS {
		scheme = "https"
	}
	_, port, _ := net.SplitHostPort(*publicAddr)
	return protocol.VisitorURL(scheme, *rootDomain, port)
}

func visitorURL(name string, ack authAckMsg) string {
	if ack.Domain != "" {
		u, err := protocol.ServerURL(serverOrigin())
		if err != nil {
			return ""
		}
		return protocol.VisitorURL(u.Scheme, name+"."+ack.Domain, u.Port())
	}
	if ack.Host != "" && ack.Port != "" {
		// Mapped ports always use their own plaintext HTTP listeners.
		return protocol.VisitorURL("http", ack.Host, ack.Port)
	}
	return ""
}

func serverHandler(opts acceptOpts) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controlHost := *rootDomain == "" || hostOnly(r.Host) == *rootDomain
		if controlHost && (r.URL.Path == protocol.ConnectPath || r.URL.Path == protocol.CheckPath) {
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", "GET")
				http.Error(w, "method not allowed", 405)
				return
			}
			if *authToken == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+*authToken)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			if r.URL.Path == protocol.CheckPath {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				_ = json.NewEncoder(w).Encode(map[string]string{"protocol": protocol.Version})
				return
			}
			supported := false
			for _, offered := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
				if strings.TrimSpace(offered) == protocol.Version {
					supported = true
				}
			}
			if !supported {
				http.Error(w, "relay/1 subprotocol required", http.StatusBadRequest)
				return
			}
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.Version}})
			if err != nil {
				return
			}
			defer ws.CloseNow()
			if ws.Subprotocol() != protocol.Version {
				return
			}
			connectionOpts := opts
			connectionOpts.exclusive = true
			handleTunnel(websocket.NetConn(r.Context(), ws, websocket.MessageBinary), connectionOpts)
			return
		}
		serveVisitorHTTP(w, r, opts.reg)
	})
}

// Only the control hostname and authenticated, connected tunnels may trigger
// certificate issuance. Wildcard DNS does not require a wildcard certificate:
// each hostname is validated via HTTP-01 on port 80, with any DNS provider.
func certificatePolicy(reg *registry) autocert.HostPolicy {
	return func(_ context.Context, host string) error {
		if host == *rootDomain {
			return nil
		}
		if strings.HasSuffix(host, "."+*rootDomain) {
			name := strings.TrimSuffix(host, "."+*rootDomain)
			if validName(name) && reg.has(name) {
				return nil
			}
		}
		return fmt.Errorf("no registered tunnel for %q", host)
	}
}

func serveAutoHTTPS(srv *http.Server, reg *registry) error {
	cache := *certDir
	if cache == "" {
		p, err := tokenFilePath()
		if err != nil {
			return err
		}
		cache = filepath.Join(filepath.Dir(p), "certs")
	}
	if err := os.MkdirAll(cache, 0700); err != nil {
		return err
	}
	manager := &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		Email:      *acmeEmail,
		Cache:      autocert.DirCache(cache),
		HostPolicy: certificatePolicy(reg),
	}
	srv.TLSConfig = manager.TLSConfig()
	// net/http also uses ReadHeaderTimeout for the TLS handshake. A cold
	// certificate needs time for ACME validation before that handshake ends.
	srv.ReadHeaderTimeout = time.Minute
	httpServer := &http.Server{Addr: ":80", Handler: manager.HTTPHandler(nil), ReadHeaderTimeout: 5 * time.Second}
	httpListener, err := net.Listen("tcp", httpServer.Addr)
	if err != nil {
		return fmt.Errorf("ACME HTTP listener: %w", err)
	}
	defer httpListener.Close()
	defer httpServer.Close()
	go func() {
		if err := httpServer.Serve(httpListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("ACME HTTP server: %v", err)
			srv.Close()
		}
	}()
	log.Printf("relayd: automatic HTTPS on %s; DNS %s and *.%s must point here", srv.Addr, *rootDomain, *rootDomain)
	return srv.ListenAndServeTLS("", "")
}
