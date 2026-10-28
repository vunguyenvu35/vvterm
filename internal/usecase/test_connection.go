package usecase

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/sshx"
)

// ConnectionTest is the outcome of SessionService.TestConnection. Failures a user can fix (wrong
// password, unreachable host, untrusted key) are reported here with OK=false instead of as errors.
type ConnectionTest struct {
	OK            bool   `json:"ok"`
	Message       string `json:"message"`
	ServerVersion string `json:"server_version,omitempty"`
	LatencyMS     int64  `json:"latency_ms"`
	Hops          int    `json:"hops"`
}

// TestConnection checks that a host (as typed in the form, not necessarily saved) can be reached and
// authenticated, then disconnects. Nothing is stored. password, when not empty, is used instead of the
// host's identity and is never persisted or logged. Unknown host keys raise term:hostkey:<promptKey>.
func (s *SessionService) TestConnection(h domain.Host, password, promptKey string) (ConnectionTest, error) {
	if strings.TrimSpace(promptKey) == "" {
		return ConnectionTest{}, errors.New("a prompt key is required")
	}
	if err := domain.NormalizeHost(&h); err != nil {
		return ConnectionTest{}, err
	}
	if strings.TrimSpace(h.Username) == "" && password == "" && h.IdentityID == "" {
		return ConnectionTest{}, errors.New("enter a username (and a password or identity) to test the connection")
	}

	var hops []sshx.Hop
	if h.JumpHostID != "" {
		chain, err := s.c.Store.JumpChain(h.JumpHostID)
		if err != nil {
			return ConnectionTest{}, fmt.Errorf("jump host: %w", err)
		}
		for _, j := range chain {
			hop, err := s.c.hopFor(j)
			if err != nil {
				return ConnectionTest{OK: false, Message: err.Error()}, nil
			}
			hops = append(hops, hop)
		}
	}
	var last sshx.Hop
	if password != "" {
		if strings.TrimSpace(h.Username) == "" {
			return ConnectionTest{}, errors.New("a username is required to test a password")
		}
		last = sshx.Hop{Label: h.Label, Hostname: h.Hostname, Port: h.Port, Username: h.Username, Auth: sshx.PasswordAuth(password)}
	} else {
		var err error
		if last, err = s.c.hopFor(h); err != nil {
			return ConnectionTest{OK: false, Message: err.Error()}, nil
		}
	}
	hops = append(hops, last)

	start := time.Now()
	cl, err := s.c.dialHops(hops, promptKey, make(chan struct{}))
	if err != nil {
		return ConnectionTest{OK: false, Message: describeDialError(err, password), Hops: len(hops)}, nil
	}
	defer cl.Close()
	return ConnectionTest{
		OK:            true,
		Message:       fmt.Sprintf("Connected to %s as %s", h.Hostname, last.Username),
		ServerVersion: string(cl.ServerVersion()),
		LatencyMS:     time.Since(start).Milliseconds(),
		Hops:          len(hops),
	}, nil
}

// describeDialError turns an SSH dial error into a message safe to show: it never echoes the password.
func describeDialError(err error, password string) string {
	msg := err.Error()
	if password != "" {
		msg = strings.ReplaceAll(msg, password, "•••")
	}
	switch {
	case errors.Is(err, sshx.ErrHostKeyChanged), errors.Is(err, sshx.ErrHostKeyRejected):
		return msg
	case strings.Contains(msg, "unable to authenticate"):
		return "Authentication failed: " + msg
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "no route"), strings.Contains(msg, "i/o timeout"), strings.Contains(msg, "no such host"):
		return "Cannot reach the host: " + msg
	}
	return msg
}
