package sshx

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func newKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	k, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func khFile(t *testing.T, lines ...string) *HostKeyChecker {
	t.Helper()
	p := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return &HostKeyChecker{Path: p}
}

func TestKnownHostsListEachNameOfALineAsItsOwnRow(t *testing.T) {
	a, b := newKey(t), newKey(t)
	c := khFile(t,
		"# my servers",
		knownhosts.Line([]string{"web.example.com", "10.0.0.1"}, a),
		"",
		knownhosts.Line([]string{"[10.0.0.5]:2222"}, b),
		"|1|abc=|def= "+strings.SplitN(string(ssh.MarshalAuthorizedKey(a)), "\n", 2)[0],
		"@cert-authority *.corp "+strings.TrimSpace(string(ssh.MarshalAuthorizedKey(b))),
		"not a valid line",
	)
	got, err := c.List()
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, h := range got {
		names = append(names, h.Host)
		if h.KeyType != "ssh-ed25519" || !strings.HasPrefix(h.Fingerprint, "SHA256:") {
			t.Fatalf("%+v", h)
		}
	}
	if strings.Join(names, ",") != "web.example.com,10.0.0.1,[10.0.0.5]:2222,(hashed)" {
		t.Fatalf("comments, markers and garbage are skipped: %v", names)
	}
	if got[0].Fingerprint != ssh.FingerprintSHA256(a) || got[2].Fingerprint != ssh.FingerprintSHA256(b) {
		t.Fatal("fingerprints")
	}
}

func TestKnownHostsListOfAMissingFileIsEmpty(t *testing.T) {
	c := &HostKeyChecker{Path: filepath.Join(t.TempDir(), "nope")}
	got, err := c.List()
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("%v %v", got, err)
	}
}

func TestForgetOneNameKeepsTheOtherAndEverythingElse(t *testing.T) {
	a, b := newKey(t), newKey(t)
	shared := knownhosts.Line([]string{"web.example.com", "10.0.0.1"}, a)
	only := knownhosts.Line([]string{"db.example.com"}, b)
	c := khFile(t, "# keep me", shared, only, "")
	n, err := c.Remove("10.0.0.1", ssh.FingerprintSHA256(a))
	if err != nil || n != 1 {
		t.Fatalf("%d %v", n, err)
	}
	raw, _ := os.ReadFile(c.Path)
	text := string(raw)
	if !strings.Contains(text, "# keep me") || !strings.Contains(text, only) {
		t.Fatalf("other lines must survive:\n%s", text)
	}
	if strings.Contains(text, "10.0.0.1") || !strings.Contains(text, "web.example.com ") {
		t.Fatalf("only the one name goes:\n%s", text)
	}
	if st, _ := os.Stat(c.Path); st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
	// the last name of a line takes the line with it
	if n, err := c.Remove("web.example.com", ssh.FingerprintSHA256(a)); err != nil || n != 1 {
		t.Fatalf("%d %v", n, err)
	}
	raw, _ = os.ReadFile(c.Path)
	if strings.Contains(string(raw), "web.example.com") || !strings.Contains(string(raw), "db.example.com") {
		t.Fatalf("\n%s", raw)
	}
}

func TestForgetRefusesWhatItCannotMatch(t *testing.T) {
	a := newKey(t)
	c := khFile(t, knownhosts.Line([]string{"web.example.com"}, a))
	for _, tc := range [][2]string{{"", "SHA256:x"}, {"web.example.com", ""}, {"(hashed)", ssh.FingerprintSHA256(a)}, {"other.example.com", ssh.FingerprintSHA256(a)}, {"web.example.com", "SHA256:wrong"}} {
		if _, err := c.Remove(tc[0], tc[1]); err == nil {
			t.Errorf("Remove(%q, %q) must fail", tc[0], tc[1])
		}
	}
	if got, _ := c.List(); len(got) != 1 {
		t.Fatalf("a refused removal changes nothing: %v", got)
	}
	if _, err := (&HostKeyChecker{Path: filepath.Join(t.TempDir(), "nope")}).Remove("a", "SHA256:x"); err == nil {
		t.Fatal("a missing file")
	}
}

// After forgetting, the next connection asks again: trust on first use starts over.
func TestAForgottenHostIsAskedAboutAgain(t *testing.T) {
	key := newKey(t)
	asked := 0
	c := &HostKeyChecker{Path: filepath.Join(t.TempDir(), "known_hosts"), Prompt: func(string, ssh.PublicKey) (bool, error) { asked++; return true, nil }}
	cb := c.Callback()
	addr := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 22}
	if err := cb("127.0.0.1:22", addr, key); err != nil || asked != 1 {
		t.Fatalf("first time asks: %v %d", err, asked)
	}
	if err := cb("127.0.0.1:22", addr, key); err != nil || asked != 1 {
		t.Fatalf("trusted: %v %d", err, asked)
	}
	list, _ := c.List()
	if len(list) != 1 {
		t.Fatalf("%v", list)
	}
	if _, err := c.Remove(list[0].Host, list[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if err := cb("127.0.0.1:22", addr, key); err != nil || asked != 2 {
		t.Fatalf("asks again after forgetting: %v %d", err, asked)
	}
}
