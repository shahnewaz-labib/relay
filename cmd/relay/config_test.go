package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shahnewaz-labib/relay/internal/protocol"
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

func TestPickServer(t *testing.T) {
	saved := clientConfig{Server: "https://mine.example"}
	for _, tc := range []struct {
		flag     string
		cfg      clientConfig
		explicit bool
		want     string
	}{
		{"", clientConfig{}, false, defaultServer},
		{"", saved, false, "https://mine.example"},
		{"https://flag.example", saved, false, "https://flag.example"},
		{"", saved, true, ""},
	} {
		if got := pickServer(tc.flag, tc.cfg, tc.explicit); got != tc.want {
			t.Errorf("pickServer(%q, %+v, %v) = %q, want %q", tc.flag, tc.cfg, tc.explicit, got, tc.want)
		}
	}
}

func TestAnonymousMode(t *testing.T) {
	if anon, err := anonymousMode(defaultServer, "", false); !anon || err != nil {
		t.Errorf("no token: got %v, %v; want true, nil", anon, err)
	}
	if anon, err := anonymousMode(defaultServer, "tok", false); anon || err != nil {
		t.Errorf("token: got %v, %v; want false, nil", anon, err)
	}
	if _, err := anonymousMode(defaultServer, "", true); err == nil || !strings.Contains(err.Error(), "custom names need your own server or a token") {
		t.Errorf("--name without token: got %v", err)
	}
	if anon, err := anonymousMode("", "", false); anon || err != nil {
		t.Errorf("raw TCP mode: got %v, %v; want false, nil", anon, err)
	}
}

func TestPickTokenKeepsPrivateTokensFromTheDefaultServer(t *testing.T) {
	// An exported RELAY_TOKEN belongs to the user's own server.
	if got := pickToken(true, "", "private", ""); got != "" {
		t.Errorf("default server got env token %q", got)
	}
	if got := pickToken(true, "explicit", "private", ""); got != "explicit" {
		t.Errorf("default server with --token = %q, want explicit", got)
	}
	if got := pickToken(false, "", "env", "saved"); got != "env" {
		t.Errorf("own server = %q, want env", got)
	}
	if got := pickToken(false, "", "", "saved"); got != "saved" {
		t.Errorf("own server = %q, want saved", got)
	}
}

func TestRejectedCredentialsMessage(t *testing.T) {
	if msg := rejectedCredentialsMessage(true); !strings.Contains(msg, "doesn't allow anonymous tunnels") {
		t.Errorf("anonymous message = %q", msg)
	}
	if msg := rejectedCredentialsMessage(false); !strings.Contains(msg, "check RELAY_TOKEN") {
		t.Errorf("token message = %q", msg)
	}
}
