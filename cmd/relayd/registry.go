package main

import (
	"errors"
	"sync"

	"relay/internal/wire"
)

var errTunnelDead = errors.New("tunnel connection is dead")

// registry tracks live tunnel connections per name. Multiple replicas of the
// same named tunnel are allowed; visitors round-robin across them.
type registry struct {
	mu sync.Mutex
	m  map[string]*entry
}

type entry struct {
	conns []*wire.Conn
	rr    uint64
}

func newRegistry() *registry {
	return &registry{m: make(map[string]*entry)}
}

func (r *registry) add(name string, c *wire.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.m[name]
	if e == nil {
		e = &entry{}
		r.m[name] = e
	}
	e.conns = append(e.conns, c)
}

func (r *registry) remove(name string, c *wire.Conn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.m[name]
	if e == nil {
		return false
	}
	kept := e.conns[:0]
	for _, x := range e.conns {
		if x != c {
			kept = append(kept, x)
		}
	}
	if len(kept) == 0 {
		delete(r.m, name)
		return true
	}
	e.conns = kept
	return false
}

// pick returns a live connection for name (round-robin), pruning dead ones.
func (r *registry) pick(name string) *wire.Conn {
	r.mu.Lock()
	defer r.mu.Unlock()

	e := r.m[name]
	if e == nil {
		return nil
	}
	live := e.conns[:0]
	for _, c := range e.conns {
		if !c.Dead() {
			live = append(live, c)
		}
	}
	e.conns = live
	if len(live) == 0 {
		delete(r.m, name)
		return nil
	}
	e.rr++
	return live[e.rr%uint64(len(live))]
}
