package protocol

import (
	"strings"
	"testing"
)

func TestAnonNameVector(t *testing.T) {
	name, ok := AnonName(strings.Repeat("0", 64))
	if !ok || name != "tunnel-60e05bd1b195" {
		t.Fatalf("AnonName = %q, %v; want tunnel-60e05bd1b195, true", name, ok)
	}
}

func TestAnonNameRejectsBadKeys(t *testing.T) {
	for _, key := range []string{"", strings.Repeat("0", 63), strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		if name, ok := AnonName(key); ok || name != "" {
			t.Errorf("AnonName(%q) = %q, %v; want rejected", key, name, ok)
		}
	}
}

func TestNewAnonKeyIsValid(t *testing.T) {
	a, err := NewAnonKey()
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewAnonKey()
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 64 {
		t.Fatalf("key length %d, want 64", len(a))
	}
	if _, ok := AnonName(a); !ok {
		t.Fatalf("AnonName rejected generated key %q", a)
	}
	if a == b {
		t.Fatal("two keys are equal")
	}
}
