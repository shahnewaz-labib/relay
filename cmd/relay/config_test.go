package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"relay/internal/protocol"
)

func TestSetupOnlyPersistsVerifiedServer(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config", "config.json")
	t.Setenv("RELAY_CONFIG", p)
	t.Setenv("RELAY_TOKEN", "secret")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != protocol.CheckPath || r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "unauthorized", 401)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"protocol": protocol.Version})
	}))
	defer srv.Close()
	if err := setup([]string{"--server", srv.URL}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("credential mode = %o", info.Mode().Perm())
	}
	want := clientConfig{Server: srv.URL, Token: "secret"}
	got, err := loadConfig()
	if err != nil || got != want {
		t.Fatalf("configuration = %+v, %v", got, err)
	}
	if err := setup([]string{"--server", srv.URL, "--token", "incorrect"}); err == nil {
		t.Fatal("bad credentials accepted")
	}
	got, err = loadConfig()
	if err != nil || got != want {
		t.Fatal("failed enrollment replaced working credentials")
	}
}

func TestSetupDoesNotFollowRedirect(t *testing.T) {
	t.Setenv("RELAY_CONFIG", filepath.Join(t.TempDir(), "config.json"))
	t.Setenv("RELAY_TOKEN", "secret")
	redirected := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected = true }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer srv.Close()
	if err := setup([]string{"--server", srv.URL}); err == nil {
		t.Fatal("accepted redirect")
	}
	if redirected {
		t.Fatal("followed redirect with credentials")
	}
}
