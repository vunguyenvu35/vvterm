package sshx

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// ErrHostKeyChanged is returned when a known host presents a different key. There is
// deliberately no override: the user must fix known_hosts by hand.
var ErrHostKeyChanged = errors.New("HOST KEY CHANGED: possible man-in-the-middle attack, connection blocked")

// ErrHostKeyRejected is returned when the user declines an unknown host key.
var ErrHostKeyRejected = errors.New("host key not trusted")

// Fingerprint returns the OpenSSH-style SHA256 fingerprint.
func Fingerprint(k ssh.PublicKey) string { return ssh.FingerprintSHA256(k) }

// HostKeyPrompt asks the user whether to trust an unknown key.
type HostKeyPrompt func(host string, key ssh.PublicKey) (bool, error)

// HostKeyChecker verifies keys against an OpenSSH known_hosts file. Unknown hosts
// go through Prompt (trust on first use) and are appended on acceptance.
// InsecureIgnoreHostKey is never used.
type HostKeyChecker struct {
	Path   string
	Prompt HostKeyPrompt
	mu     sync.Mutex
}

func (c *HostKeyChecker) Callback() ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		c.mu.Lock()
		defer c.mu.Unlock()
		if err := os.MkdirAll(filepath.Dir(c.Path), 0o700); err != nil {
			return err
		}
		if _, err := os.Stat(c.Path); errors.Is(err, os.ErrNotExist) {
			if err := os.WriteFile(c.Path, nil, 0o600); err != nil {
				return err
			}
		}
		// Re-read each time so keys trusted by earlier sessions apply immediately.
		kh, err := knownhosts.New(c.Path)
		if err != nil {
			return fmt.Errorf("known_hosts: %w", err)
		}
		err = kh(hostname, remote, key)
		if err == nil {
			return nil
		}
		var ke *knownhosts.KeyError
		if !errors.As(err, &ke) {
			return err
		}
		if len(ke.Want) > 0 {
			return ErrHostKeyChanged
		}
		if c.Prompt == nil {
			return ErrHostKeyRejected
		}
		ok, err := c.Prompt(hostname, key)
		if err != nil {
			return err
		}
		if !ok {
			return ErrHostKeyRejected
		}
		line := knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key)
		f, err := os.OpenFile(c.Path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.WriteString(line + "\n")
		return err
	}
}
