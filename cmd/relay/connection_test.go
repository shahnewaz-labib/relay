package main

import (
	"io"
	"net"
	"testing"
	"time"

	"relay/internal/wire"
)

func TestTunnelDisconnectClosesIdleLocalConnection(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	previous := *localAddr
	*localAddr = listener.Addr().String()
	defer func() { *localAddr = previous }()
	a, b := net.Pipe()
	server, client := wire.New(a), wire.New(b)
	defer server.Close()
	defer client.Close()
	go func() {
		for range server.Events() {
		}
	}()
	bound := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range client.Events() {
			if ev.Type == wire.Syn {
				go func() { defer close(bound); bind(client, ev.ID) }()
			}
		}
	}()
	if _, err := server.Open(); err != nil {
		t.Fatal(err)
	}
	listener.(*net.TCPListener).SetDeadline(time.Now().Add(3 * time.Second))
	origin, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer origin.Close()
	server.Close()
	origin.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := origin.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("idle origin remains open after tunnel disconnect: %v", err)
	}
	select {
	case <-bound:
	case <-time.After(3 * time.Second):
		t.Fatal("bind did not stop")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("event loop did not stop")
	}
}
