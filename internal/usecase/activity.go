package usecase

import (
	"errors"
	"fmt"
	"strings"

	"vvterm/internal/domain"
	"vvterm/internal/sshx"
)

// record adds a line to the activity log and tells the UI. It never fails the action it describes: a log
// that cannot be written is only a missing log. Messages must never carry a secret.
func (c *Core) record(kind, hostID, label, msg string, ok bool) {
	if c.Activity == nil {
		return
	}
	if label == "" && hostID != "" {
		label = c.hostLabel(hostID)
	}
	if err := c.Activity.Add(domain.ActivityEntry{Kind: kind, HostID: hostID, HostLabel: label, Message: msg, OK: ok}); err == nil {
		c.emit("log:added")
	}
}

// hostLabel is the name shown next to a log line: the host's label, "This computer", or the serial device.
func (c *Core) hostLabel(hostID string) string {
	switch {
	case hostID == LocalHostID:
		return "This computer"
	case strings.HasPrefix(hostID, serialPrefix):
		if p, _, err := ParseSerialID(hostID); err == nil {
			return p
		}
		return hostID
	case strings.HasPrefix(hostID, telnetPrefix):
		hostID = strings.TrimPrefix(hostID, telnetPrefix)
	}
	if h, err := c.Store.GetHost(hostID); err == nil {
		return h.Label
	}
	return ""
}

// logEnd records how a terminal session ended: by the user, by the server, or never started.
func (s *SessionService) logEnd(sess *session, reason string, clean bool) {
	switch {
	case clean:
		s.c.record(domain.ActDisconnect, sess.hostID, "", "Session ended", true)
	case strings.HasPrefix(reason, "connection lost"):
		s.c.record(domain.ActDisconnect, sess.hostID, "", "Connection lost: "+strings.TrimPrefix(reason, "connection lost: "), false)
	default:
		s.c.record(domain.ActConnect, sess.hostID, "", "Connection failed: "+reason, false)
	}
}

// LogService reads and clears the activity log for the Logs page.
type LogService struct{ c *Core }

func NewLogService(c *Core) *LogService { return &LogService{c: c} }

// List returns the newest lines first (never null).
func (s *LogService) List(f domain.ActivityFilter) ([]domain.ActivityEntry, error) {
	if s.c.Activity == nil {
		return []domain.ActivityEntry{}, nil
	}
	return s.c.Activity.List(f)
}

// Clear forgets the whole history.
func (s *LogService) Clear() error {
	if s.c.Activity == nil {
		return nil
	}
	if err := s.c.Activity.Clear(); err != nil {
		return err
	}
	s.c.emit("log:added")
	return nil
}

// KnownHostsService lists the machines whose key was trusted, and forgets them on request.
type KnownHostsService struct{ c *Core }

func NewKnownHostsService(c *Core) *KnownHostsService { return &KnownHostsService{c: c} }

func (s *KnownHostsService) checker() (*sshx.HostKeyChecker, error) {
	if s.c.Dialer == nil || s.c.Dialer.HostKeys == nil {
		return nil, errors.New("known hosts are not available")
	}
	return s.c.Dialer.HostKeys, nil
}

// List returns every trusted host (never null).
func (s *KnownHostsService) List() ([]sshx.KnownHost, error) {
	c, err := s.checker()
	if err != nil {
		return nil, err
	}
	return c.List()
}

// Forget removes a host's key: the next connection to it asks to trust it again.
func (s *KnownHostsService) Forget(host, fingerprint string) error {
	c, err := s.checker()
	if err != nil {
		return err
	}
	if _, err := c.Remove(host, fingerprint); err != nil {
		return err
	}
	s.c.record(domain.ActHostKey, "", host, "Forgot the host key "+fingerprint, true)
	return nil
}

// summarizeTransfer is the log line for a finished batch: "Uploaded 3 files and 1 folder (1.2 MB) to /srv".
func summarizeTransfer(verb string, r TransferResult, where string) string {
	var parts []string
	if r.Files > 0 {
		parts = append(parts, fmt.Sprintf("%d %s", r.Files, plural(r.Files, "file", "files")))
	}
	if r.Dirs > 0 {
		parts = append(parts, fmt.Sprintf("%d %s", r.Dirs, plural(r.Dirs, "folder", "folders")))
	}
	text := "Nothing to transfer"
	if len(parts) > 0 {
		text = fmt.Sprintf("%s %s (%s) %s", verb, strings.Join(parts, " and "), humanBytes(r.Bytes), where)
	}
	if n := len(r.Skipped); n > 0 {
		text += fmt.Sprintf(", %d left as they were", n)
	}
	return text
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func humanBytes(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	v, units := float64(n)/1024, []string{"KB", "MB", "GB", "TB"}
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	if v >= 100 {
		return fmt.Sprintf("%.0f %s", v, units[i])
	}
	return fmt.Sprintf("%.1f %s", v, units[i])
}
