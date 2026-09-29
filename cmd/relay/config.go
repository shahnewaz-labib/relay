package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"

	"relay/internal/protocol"
)

type clientConfig struct {
	Server string `json:"server"`
	Token  string `json:"token"`
}

func configPath() (string, error) {
	if p := os.Getenv("RELAY_CONFIG"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "relay", "config.json"), nil
}

func loadConfig() (clientConfig, error) {
	var cfg clientConfig
	p, err := configPath()
	if err != nil {
		return cfg, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	err = json.Unmarshal(b, &cfg)
	return cfg, err
}

func saveConfig(cfg clientConfig) (string, error) {
	p, err := configPath()
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return "", err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp(filepath.Dir(p), ".relay-config-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(append(b, '\n')); err != nil {
		f.Close()
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	if err = os.Rename(f.Name(), p); err != nil {
		return "", err
	}
	return p, nil
}

func setup(args []string) error {
	fs := flag.NewFlagSet("relay setup", flag.ContinueOnError)
	server := fs.String("server", "", "Relay server URL, e.g. https://tunnels.example.com")
	secret := fs.String("token", "", "server token (default: RELAY_TOKEN or hidden prompt)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *server == "" || fs.NArg() != 0 {
		return errors.New("usage: relay setup --server https://tunnels.example.com")
	}
	u, err := protocol.ServerURL(*server)
	if err != nil {
		return err
	}
	if *secret == "" {
		*secret = os.Getenv("RELAY_TOKEN")
	}
	if *secret == "" {
		fmt.Fprint(os.Stderr, "Server token: ")
		var b []byte
		if term.IsTerminal(int(os.Stdin.Fd())) {
			b, err = term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
		} else {
			var line string
			line, err = bufio.NewReader(os.Stdin).ReadString('\n')
			// A pipe may end without a trailing newline.
			if len(line) > 0 {
				err = nil
			}
			b = []byte(line)
		}
		if err != nil {
			return err
		}
		*secret = strings.TrimSpace(string(b))
	}
	if *secret == "" {
		return errors.New("token is required")
	}
	check := *u
	check.Path = protocol.CheckPath
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, check.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+*secret)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("check server: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server check: %s", resp.Status)
	}
	var info struct {
		Protocol string `json:"protocol"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return err
	}
	if info.Protocol != protocol.Version {
		return fmt.Errorf("unsupported server protocol %q", info.Protocol)
	}
	p, err := saveConfig(clientConfig{Server: u.String(), Token: *secret})
	if err != nil {
		return err
	}
	fmt.Printf("Saved %s\nRun: relay 3000\n", p)
	return nil
}

func localPort(value string) (string, error) {
	p, err := strconv.Atoi(value)
	if err != nil || p < 1 || p > 65535 {
		return "", fmt.Errorf("invalid local port %q", value)
	}
	return net.JoinHostPort("localhost", strconv.Itoa(p)), nil
}

// Accept the documented `relay 3000 --name demo` as well as flags-first usage.
func commandArgs(args []string) []string {
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		return append(append([]string{}, args[1:]...), args[0])
	}
	return args
}
