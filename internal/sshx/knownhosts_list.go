package sshx

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"
)

// KnownHost is one entry of the known_hosts file: a machine whose key the user trusted.
type KnownHost struct {
	Host        string `json:"host"`        // "example.com", "[10.0.0.5]:2222", or "(hashed)" for hashed entries
	KeyType     string `json:"key_type"`    // ssh-ed25519, ssh-rsa…
	Fingerprint string `json:"fingerprint"` // SHA256:…
}

// parseLine returns the hosts, key and whether the line is an entry (comments and blanks are not).
func parseLine(line []byte) (hosts []string, key ssh.PublicKey, ok bool) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] == '#' {
		return nil, nil, false
	}
	marker, hosts, key, _, _, err := ssh.ParseKnownHosts(line)
	if err != nil || marker != "" { // @cert-authority and @revoked lines are not trusted-host entries: left alone
		return nil, nil, false
	}
	return hosts, key, true
}

// List returns the trusted hosts, one row per host and key. An OpenSSH file may name several hosts on a
// line ("a.example.com,10.0.0.1 ssh-ed25519 …"): each becomes its own row so each can be forgotten.
func (c *HostKeyChecker) List() ([]KnownHost, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	raw, err := os.ReadFile(c.Path)
	if errors.Is(err, os.ErrNotExist) {
		return []KnownHost{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []KnownHost{}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		hosts, key, ok := parseLine(sc.Bytes())
		if !ok {
			continue
		}
		for _, h := range hosts {
			name := h
			if strings.HasPrefix(h, "|1|") {
				name = "(hashed)"
			}
			out = append(out, KnownHost{Host: name, KeyType: key.Type(), Fingerprint: ssh.FingerprintSHA256(key)})
		}
	}
	return out, sc.Err()
}

// Remove makes VVTerm forget a host: the next connection asks again. It removes the host's name from every
// line that carries that key (the whole line when it was the only name) and keeps everything else, comments
// included, exactly as it was. It returns how many entries were removed.
func (c *HostKeyChecker) Remove(host, fingerprint string) (int, error) {
	if host == "" || host == "(hashed)" || fingerprint == "" {
		return 0, errors.New("choose a host with a known name to forget")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	raw, err := os.ReadFile(c.Path)
	if err != nil {
		return 0, err
	}
	removed := 0
	var out []string
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		text := sc.Text()
		hosts, key, ok := parseLine([]byte(text))
		if !ok || ssh.FingerprintSHA256(key) != fingerprint {
			out = append(out, text)
			continue
		}
		var keep []string
		for _, h := range hosts {
			if h == host {
				removed++
			} else {
				keep = append(keep, h)
			}
		}
		switch {
		case len(keep) == len(hosts):
			out = append(out, text) // not this host
		case len(keep) == 0: // the only name: the whole line goes
		default:
			out = append(out, fmt.Sprintf("%s %s", strings.Join(keep, ","), strings.TrimSpace(afterHosts(text))))
		}
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	if removed == 0 {
		return 0, errors.New("that host is not in known_hosts")
	}
	body := strings.Join(out, "\n")
	if len(out) > 0 {
		body += "\n"
	}
	tmp := c.Path + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o600); err != nil {
		return 0, err
	}
	return removed, os.Rename(tmp, c.Path)
}

// afterHosts returns the line without its first field (the host list), keeping a leading @marker aside.
func afterHosts(line string) string {
	f := strings.Fields(line)
	if len(f) == 0 {
		return ""
	}
	i := 0
	if strings.HasPrefix(f[0], "@") {
		i = 1
	}
	if len(f) <= i+1 {
		return ""
	}
	return strings.Join(f[i+1:], " ")
}
