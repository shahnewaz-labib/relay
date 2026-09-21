package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"net/http/httputil"

	"relay/internal/wire"
)

// beKey carries the chosen backend connection through the request context
// from Director to DialContext.
type beKey struct{}

// httputilProxy builds a reverse proxy that forwards one visitor request over
// a fresh stream on the given tunnel connection. DisableKeepAlives keeps the
// stream-per-request invariant (pooled streams would outlive dead tunnels).
func httputilProxy(be *wire.Conn) http.Handler {
	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = "http"
			req.URL.Host = "relay.origin" // placeholder; real dialing goes over the tunnel
			*req = *req.WithContext(context.WithValue(req.Context(), beKey{}, be))
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				be, ok := ctx.Value(beKey{}).(*wire.Conn)
				if !ok || be.Dead() {
					return nil, errTunnelDead
				}
				return be.Open() // a wire.Stream satisfies net.Conn
			},
			DisableKeepAlives: true,
		},
		FlushInterval: -1, // stream responses immediately (SSE/websocket-friendly)
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("proxy %s %s: %v", r.Method, r.Host, err)
			badGateway(w)
		},
	}
}
