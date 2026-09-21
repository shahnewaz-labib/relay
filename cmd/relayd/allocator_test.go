package main

import (
	"sync"
	"testing"
)

func TestAllocatorLifecycle(t *testing.T) {
	var (
		mu      sync.Mutex
		started = map[string]int{}
		stopped = map[string]int{}
	)
	onStart := func(name, addr string) error {
		mu.Lock()
		started[name]++
		mu.Unlock()
		return nil
	}
	onStop := func(name, addr string) {
		mu.Lock()
		stopped[name]++
		mu.Unlock()
	}

	pa := newPortAlloc(20000, 20002, "" /* no persistence in tests */, onStart, onStop)
	pa.ReserveStatic("pinned", 20010)

	// First client: fresh allocation, listener started.
	p, err := pa.Ensure("alice")
	if err != nil || p != 20000 {
		t.Fatalf("got %d, %v; want 20000", p, err)
	}

	// Reconnect while active: no duplicate start.
	if _, err := pa.Ensure("alice"); err != nil {
		t.Fatal(err)
	}
	if started["alice"] != 1 {
		t.Fatalf("alice started %d times, want 1", started["alice"])
	}

	// Last replica leaves: deactivated.
	pa.Deactivate("alice")
	if stopped["alice"] != 1 {
		t.Fatalf("alice stopped %d times, want 1", stopped["alice"])
	}
	// Double-deactivate is a no-op.
	pa.Deactivate("alice")
	if stopped["alice"] != 1 {
		t.Fatalf("double deactivate ran stop again")
	}

	// Returns on the SAME persisted port with a restarted listener.
	p2, err := pa.Ensure("alice")
	if err != nil || p2 != 20000 {
		t.Fatalf("reconnect got %d, %v; want 20000", p2, err)
	}
	if started["alice"] != 2 {
		t.Fatalf("alice started %d times after reconnect, want 2", started["alice"])
	}

	// Second name gets the next port; first stays untouched.
	p3, err := pa.Ensure("bob")
	if err != nil || p3 != 20001 {
		t.Fatalf("bob got %d, %v; want 20001", p3, err)
	}

	// Pinned names ignore deactivation entirely.
	pa.Deactivate("pinned")
	if stopped["pinned"] != 0 {
		t.Fatalf("pinned tunnel was stopped")
	}

	// Unknown names are harmless.
	pa.Deactivate("ghost")
}

func TestRangeExhaustion(t *testing.T) {
	pa := newPortAlloc(30000, 30001, "",
		func(name, addr string) error { return nil },
		func(name, addr string) {})

	for _, n := range []string{"a", "b"} {
		if _, err := pa.Ensure(n); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pa.Ensure("c"); err == nil {
		t.Fatal("expected exhaustion error")
	}
}
