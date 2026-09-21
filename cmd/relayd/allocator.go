package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
)

// portAlloc hands out stable public ports to tunnel names and manages their
// listener lifecycle.
//
// Sources of truth, in order:
//  1. static --port-map entries (operator-pinned: always listening, never
//     deactivated)
//  2. previously assigned ranges persisted in portsFile (~/.relayd/ports.json)
//  3. fresh picks from the configured range, lowest-first
//
// Persisting matters: without it, a relayd restart could hand a different
// port to an existing tunnel name and silently break everyone's bookmarks.
//
// Lifecycle: a dynamic port's listener starts when its tunnel first (or
// again) authenticates, and stops when the last replica of that name
// disconnects (Deactivate). With --manage-firewall, the same hooks open and
// close the UFW rule, so unused ports present zero attack surface.
type portAlloc struct {
	mu     sync.Mutex
	start  int
	end    int
	used   map[int]string
	byName map[string]int
	pinned map[string]bool // static --port-map entries: permanent listeners
	active map[string]bool // listener currently bound?
	path   string          // "" = don't persist (tests)

	onStart func(name, addr string) error // bind listener (+open firewall); error = unusable
	onStop  func(name, addr string)       // unbind listener (+close firewall)
}

func newPortAlloc(start, end int, path string,
	onStart func(name, addr string) error,
	onStop func(name, addr string),
) *portAlloc {
	pa := &portAlloc{
		start:   start,
		end:     end,
		used:    make(map[int]string),
		byName:  make(map[string]int),
		pinned:  make(map[string]bool),
		active:  make(map[string]bool),
		path:    path,
		onStart: onStart,
		onStop:  onStop,
	}
	pa.load()
	return pa
}

type portFile map[string]int

func (pa *portAlloc) load() {
	if pa.path == "" {
		return
	}
	b, err := os.ReadFile(pa.path)
	if err != nil {
		return // first run
	}
	var pf portFile
	if err := json.Unmarshal(b, &pf); err != nil {
		log.Printf("warning: ignoring unreadable %s: %v", pa.path, err)
		return
	}
	for name, port := range pf {
		pa.used[port] = name
		pa.byName[name] = port
		// not active: listeners start when clients reconnect
	}
}

func (pa *portAlloc) save() {
	if pa.path == "" {
		return
	}
	b, _ := json.MarshalIndent(portFile(pa.byName), "", "  ")
	if err := os.WriteFile(pa.path, b, 0o600); err != nil {
		log.Printf("warning: could not persist port assignments: %v", err)
	}
}

// ReserveStatic pins an operator-chosen mapping: its listener is started by
// main at boot, never deactivated, and excluded from the dynamic pool.
func (pa *portAlloc) ReserveStatic(name string, port int) {
	pa.mu.Lock()
	defer pa.mu.Unlock()
	pa.used[port] = name
	pa.byName[name] = port
	pa.pinned[name] = true
	pa.active[name] = true
}

// Ensure returns the port for name, assigning (and announcing) a new one
// from the range if needed, and guarantees a live listener.
func (pa *portAlloc) Ensure(name string) (int, error) {
	pa.mu.Lock()
	defer pa.mu.Unlock()

	if p, ok := pa.byName[name]; ok {
		if !pa.active[name] && !pa.pinned[name] {
			addr := fmt.Sprintf(":%d", p)
			if err := pa.onStart(name, addr); err != nil {
				return 0, fmt.Errorf("could not reactivate port %d: %w", p, err)
			}
			pa.active[name] = true
			log.Printf("reactivated port %s -> tunnel %q", addr, name)
		}
		return p, nil
	}
	for port := pa.start; port <= pa.end; port++ {
		if _, taken := pa.used[port]; taken {
			continue
		}
		addr := fmt.Sprintf(":%d", port)
		if err := pa.onStart(name, addr); err != nil {
			continue // something external owns this port; try the next
		}
		pa.used[port] = name
		pa.byName[name] = port
		pa.active[name] = true
		pa.save()
		log.Printf("auto-assigned port %s -> tunnel %q", addr, name)
		return port, nil
	}
	return 0, fmt.Errorf("no free ports left in range %d-%d", pa.start, pa.end)
}

// Deactivate stops the listener (and closes its firewall rule) for name —
// but only when it is dynamically allocated and no replica holds it anymore.
func (pa *portAlloc) Deactivate(name string) {
	pa.mu.Lock()
	defer pa.mu.Unlock()

	if pa.pinned[name] || !pa.active[name] {
		return
	}
	if p, ok := pa.byName[name]; ok {
		pa.onStop(name, fmt.Sprintf(":%d", p))
		pa.active[name] = false
	}
}
