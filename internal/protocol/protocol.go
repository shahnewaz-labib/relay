// Package protocol defines the backend-independent Relay connection contract.
package protocol

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

const (
	Version     = "relay/1"
	ConnectPath = "/_relay/connect"
	CheckPath   = "/_relay/check"
)

type Auth struct {
	Name  string `json:"name"`
	Token string `json:"token"`
}

type AuthAck struct {
	URL    string `json:"url,omitempty"`
	Domain string `json:"domain"`
	Host   string `json:"host"`
	Port   string `json:"port"`
	Scheme string `json:"scheme"`
}

var namePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func ValidName(name string) bool { return namePattern.MatchString(name) }

func NormalizeDomain(domain string) (string, error) {
	domain = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(domain), "."))
	if len(domain) > 253 || !strings.Contains(domain, ".") || net.ParseIP(domain) != nil {
		return "", fmt.Errorf("invalid domain %q: use a DNS name, such as tunnels.example.com", domain)
	}
	for _, label := range strings.Split(domain, ".") {
		if !ValidName(label) {
			return "", fmt.Errorf("invalid domain %q", domain)
		}
	}
	return domain, nil
}

func RandomName() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "tunnel-" + hex.EncodeToString(b[:]), nil
}

// ServerURL accepts a bare hostname or an HTTP(S) origin. Paths are reserved
// by the protocol so changing backends only requires changing this origin.
func ServerURL(value string) (*url.URL, error) {
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil {
		return nil, err
	}
	if (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("server must be an HTTP(S) origin, such as https://tunnels.example.com")
	}
	u.Path = ""
	return u, nil
}

func VisitorURL(scheme, host, port string) string {
	if port != "" && !(scheme == "https" && port == "443") && !(scheme == "http" && port == "80") {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return (&url.URL{Scheme: scheme, Host: host}).String()
}
