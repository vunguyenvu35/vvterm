package domain

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// MaxJumpDepth bounds jump host chains to avoid loops.
const MaxJumpDepth = 8

// ErrNotFound is returned when a referenced record does not exist.
var ErrNotFound = errors.New("record not found")

// IsLoopback reports whether addr is a loopback IP or "localhost".
func IsLoopback(addr string) bool {
	if strings.EqualFold(addr, "localhost") {
		return true
	}
	ip := net.ParseIP(addr)
	return ip != nil && ip.IsLoopback()
}

// NormalizeHost validates a host and fills defaults (label, port, keepalive).
// Hostname and username are checked for whitespace/control characters because they end up in
// exported ssh config files, where a newline would inject extra directives.
func NormalizeHost(h *Host) error {
	if strings.TrimSpace(h.Hostname) == "" {
		return errors.New("hostname is required")
	}
	if strings.ContainsAny(h.Hostname+h.Username, " \t\r\n\x00") {
		return errors.New("hostname and username must not contain whitespace or control characters")
	}
	if h.Label == "" {
		h.Label = h.Hostname
	}
	if h.Port == 0 {
		h.Port = 22
	}
	if h.Port < 1 || h.Port > 65535 {
		return errors.New("port out of range")
	}
	switch h.Env {
	case "", EnvDev, EnvStaging, EnvProd:
	default:
		return fmt.Errorf("invalid env %q", h.Env)
	}
	if h.KeepaliveSec == 0 {
		h.KeepaliveSec = 30
	}
	return nil
}

// NormalizeForward validates a port forward and applies the safe default bind address.
// Binding anything but loopback requires AllowPublicBind to be set explicitly.
func NormalizeForward(f *PortForward) error {
	switch f.Type {
	case ForwardLocal, ForwardRemote:
		if f.DestHost == "" || f.DestPort < 1 || f.DestPort > 65535 {
			return errors.New("destination host and port are required")
		}
	case ForwardDynamic:
	default:
		return fmt.Errorf("invalid forward type %q", f.Type)
	}
	if f.BindPort < 0 || f.BindPort > 65535 {
		return errors.New("bind port out of range")
	}
	if f.BindAddr == "" {
		f.BindAddr = "127.0.0.1"
	}
	if !f.AllowPublicBind && !IsLoopback(f.BindAddr) {
		return fmt.Errorf("binding to %s exposes the forward to the network: enable allow_public_bind explicitly", f.BindAddr)
	}
	return nil
}

// CheckJumpChain verifies that making `self` jump through `jump` cannot loop or exceed
// MaxJumpDepth. lookup returns a host by id.
func CheckJumpChain(self, jump string, lookup func(id string) (Host, bool)) error {
	seen := map[string]bool{}
	for id, n := jump, 0; id != ""; n++ {
		if id == self && self != "" {
			return errors.New("jump host chain forms a loop")
		}
		if seen[id] || n >= MaxJumpDepth {
			return errors.New("jump host chain too deep or looping")
		}
		seen[id] = true
		h, ok := lookup(id)
		if !ok {
			return fmt.Errorf("jump host: %w", ErrNotFound)
		}
		id = h.JumpHostID
	}
	return nil
}
