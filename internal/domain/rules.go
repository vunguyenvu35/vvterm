package domain

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
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
	if h.OS != "" && !KnownOS[h.OS] {
		return fmt.Errorf("invalid os %q", h.OS)
	}
	if h.TelnetEnabled && h.TelnetPort == 0 {
		h.TelnetPort = 23
	}
	if h.TelnetPort < 0 || h.TelnetPort > 65535 {
		return errors.New("telnet port out of range")
	}
	if !h.TelnetEnabled {
		h.TelnetPort = 0 // a port without Telnet means nothing
	}
	if len(h.TelnetUsername) > 128 || strings.ContainsAny(h.TelnetUsername, "\r\n\x00") {
		return errors.New("invalid telnet user name")
	}
	switch h.TelnetEncoding = strings.ToLower(strings.TrimSpace(h.TelnetEncoding)); h.TelnetEncoding {
	case "", "utf-8", "iso-8859-1":
	default:
		return errors.New("unknown telnet encoding")
	}
	switch h.AIPolicy {
	case "", "off", "ask", "on":
	default:
		return fmt.Errorf("invalid assistant policy %q", h.AIPolicy)
	}
	if len(h.TerminalTheme) > 40 || strings.ContainsAny(h.TerminalTheme, " \t\r\n\x00/\\") {
		return errors.New("invalid terminal theme")
	}
	return nil
}

// NormalizeForward validates a port forward and applies the safe default bind address.
// Binding anything but loopback requires AllowPublicBind to be set explicitly.
func NormalizeForward(f *PortForward) error {
	f.Label = strings.TrimSpace(f.Label)
	if len([]rune(f.Label)) > 80 || strings.ContainsAny(f.Label, "\r\n\x00") {
		return errors.New("label must be a single line of at most 80 characters")
	}
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

// MaxSnippetBytes bounds a snippet script (it is typed into a terminal).
const MaxSnippetBytes = 64 * 1024

// NormalizeSnippet validates a snippet and trims its label. Scripts keep their exact text, but NUL
// bytes are rejected: they cannot be typed into a terminal and often hide garbage.
func NormalizeSnippet(s *Snippet) error {
	s.Label = strings.TrimSpace(s.Label)
	if s.Label == "" {
		return errors.New("snippet label is required")
	}
	if strings.TrimSpace(s.Script) == "" {
		return errors.New("snippet script is required")
	}
	if len(s.Script) > MaxSnippetBytes {
		return fmt.Errorf("snippet script is larger than %d KiB", MaxSnippetBytes/1024)
	}
	if strings.ContainsRune(s.Script, 0) {
		return errors.New("snippet script must not contain NUL characters")
	}
	return nil
}

// MaxActivityMessage bounds one log line.
const MaxActivityMessage = 500

// NormalizeActivity makes an entry safe to store: one line, bounded, with a known kind.
func NormalizeActivity(e *ActivityEntry) error {
	switch e.Kind {
	case ActConnect, ActDisconnect, ActHostKey, ActForward, ActSFTP, ActTransfer, ActVault, ActSync:
	default:
		return fmt.Errorf("invalid activity kind %q", e.Kind)
	}
	e.Message = strings.Join(strings.Fields(strings.ReplaceAll(e.Message, "\x00", "")), " ")
	if r := []rune(e.Message); len(r) > MaxActivityMessage {
		e.Message = string(r[:MaxActivityMessage-1]) + "…"
	}
	if e.Message == "" {
		return errors.New("an activity needs a message")
	}
	if e.At.IsZero() {
		e.At = time.Now()
	}
	return nil
}
