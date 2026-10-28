package sshx

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/testssh"
	"vvterm/internal/vault"
)

func hopFor(label string, s *testssh.Server, auth ...ssh.AuthMethod) Hop {
	return Hop{Label: label, Hostname: "127.0.0.1", Port: s.Port(), Username: "root", Auth: auth}
}

func pwAuth() []ssh.AuthMethod { return PasswordAuth("pw") }

func newDialer(t *testing.T, accept bool) (*Dialer, *int) {
	t.Helper()
	prompts := 0
	hk := &HostKeyChecker{Path: filepath.Join(t.TempDir(), "known_hosts"),
		Prompt: func(string, ssh.PublicKey) (bool, error) { prompts++; return accept, nil }}
	return &Dialer{HostKeys: hk, Timeout: 5 * time.Second}, &prompts
}

func startSrv(t *testing.T) *testssh.Server {
	t.Helper()
	s, err := testssh.Start(testssh.Config{User: "root", Password: "pw"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

type sink struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *sink) add(p []byte) { s.mu.Lock(); s.b.Write(p); s.mu.Unlock() }
func (s *sink) has(x string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Contains(s.b.String(), x)
}

func TestPasswordLoginAndShellEcho(t *testing.T) {
	srv := startSrv(t)
	d, _ := newDialer(t, true)
	c, err := d.Dial([]Hop{hopFor("t", srv, pwAuth()...)})
	if err != nil {
		t.Fatal(err)
	}
	var out sink
	sh, err := c.OpenShell(100, 30, out.add)
	if err != nil {
		t.Fatal(err)
	}
	defer sh.Close()
	waitFor(t, "READY", func() bool { return out.has("READY") })
	if cols, rows := srv.LastWindow(); cols != 100 || rows != 30 {
		t.Fatalf("pty size %dx%d", cols, rows)
	}
	sh.Write([]byte("hello\r"))
	waitFor(t, "echo", func() bool { return out.has("ECHO:hello") })

	if err := sh.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "resize", func() bool { c, r := srv.LastWindow(); return c == 120 && r == 40 })

	sh.Write([]byte("exit\r"))
	select {
	case <-sh.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("shell did not exit")
	}
	if err := sh.Err(); err != nil {
		t.Fatalf("clean exit reported error: %v", err)
	}
}

func TestWrongPasswordFails(t *testing.T) {
	srv := startSrv(t)
	d, _ := newDialer(t, true)
	_, err := d.Dial([]Hop{hopFor("t", srv, PasswordAuth("bad")...)})
	if err == nil {
		t.Fatal("expected auth failure")
	}
}

func TestKeyAuth(t *testing.T) {
	privPEM, pub, err := vault.GenerateEd25519("t")
	if err != nil {
		t.Fatal(err)
	}
	pk, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(pub))
	srv, _ := testssh.Start(testssh.Config{User: "root", AuthKeys: []ssh.PublicKey{pk}})
	defer srv.Close()
	signer, _ := vault.ParsePrivateKey(privPEM, nil)
	d, _ := newDialer(t, true)
	c, err := d.Dial([]Hop{hopFor("t", srv, KeyAuth(signer))})
	if err != nil {
		t.Fatal(err)
	}
	c.Close()

	other, _ := ssh.NewSignerFromKey(mustKey(t))
	if _, err := d.Dial([]Hop{hopFor("t", srv, KeyAuth(other))}); err == nil {
		t.Fatal("unauthorised key accepted")
	}
}

func TestUnknownHostPromptsOnceThenTrusted(t *testing.T) {
	srv := startSrv(t)
	d, prompts := newDialer(t, true)
	for i := 0; i < 3; i++ {
		c, err := d.Dial([]Hop{hopFor("t", srv, pwAuth()...)})
		if err != nil {
			t.Fatal(err)
		}
		c.Close()
	}
	if *prompts != 1 {
		t.Fatalf("prompted %d times, want 1", *prompts)
	}
	b, _ := os.ReadFile(d.HostKeys.Path)
	if !strings.Contains(string(b), "ssh-ed25519") || !strings.Contains(string(b), strconv.Itoa(srv.Port())) {
		t.Fatalf("known_hosts not written in OpenSSH format: %q", b)
	}
}

func TestRejectedHostKeyBlocksAndStoresNothing(t *testing.T) {
	srv := startSrv(t)
	d, _ := newDialer(t, false)
	_, err := d.Dial([]Hop{hopFor("t", srv, pwAuth()...)})
	if err == nil || !errors.Is(err, ErrHostKeyRejected) {
		t.Fatalf("got %v", err)
	}
	b, _ := os.ReadFile(d.HostKeys.Path)
	if len(b) != 0 {
		t.Fatalf("known_hosts should be empty: %q", b)
	}
	if srv.Logins() != 0 {
		t.Fatal("authenticated against an untrusted host")
	}
}

func TestChangedHostKeyIsBlockedWithoutPrompt(t *testing.T) {
	a := startSrv(t)
	d, prompts := newDialer(t, true)
	c, err := d.Dial([]Hop{hopFor("t", a, pwAuth()...)})
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	port := a.Port()
	a.Close()

	// new server with a different key on the same port
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Skipf("cannot reuse port: %v", err)
	}
	ln.Close()
	_ = ln
	b, err := testssh.StartOn("127.0.0.1:"+strconv.Itoa(port), testssh.Config{User: "root", Password: "pw"})
	if err != nil {
		t.Skipf("cannot reuse port: %v", err)
	}
	defer b.Close()
	before := *prompts
	_, err = d.Dial([]Hop{{Label: "t", Hostname: "127.0.0.1", Port: port, Username: "root", Auth: pwAuth()}})
	if !errors.Is(err, ErrHostKeyChanged) {
		t.Fatalf("got %v, want ErrHostKeyChanged", err)
	}
	if *prompts != before {
		t.Fatal("user was offered an override for a changed key")
	}
	if b.Logins() != 0 {
		t.Fatal("credentials sent to a host with a changed key")
	}
}

func TestJumpHostChain(t *testing.T) {
	bastion := startSrv(t)
	target := startSrv(t)
	d, _ := newDialer(t, true)
	c, err := d.Dial([]Hop{hopFor("bastion", bastion, pwAuth()...), hopFor("target", target, pwAuth()...)})
	if err != nil {
		t.Fatal(err)
	}
	var out sink
	sh, err := c.OpenShell(80, 24, out.add)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "READY via jump", func() bool { return out.has("READY") })
	if target.Logins() != 1 || bastion.Logins() != 1 {
		t.Fatalf("logins bastion=%d target=%d", bastion.Logins(), target.Logins())
	}
	sh.Close() // must also close the jump connection
	waitFor(t, "jump closed", func() bool {
		_, _, err := c.jumps[0].SendRequest("keepalive@openssh.com", true, nil)
		return err != nil
	})
}

func TestThreeHopChainAndDepthLimit(t *testing.T) {
	a, b, c3 := startSrv(t), startSrv(t), startSrv(t)
	d, _ := newDialer(t, true)
	cl, err := d.Dial([]Hop{hopFor("a", a, pwAuth()...), hopFor("b", b, pwAuth()...), hopFor("c", c3, pwAuth()...)})
	if err != nil {
		t.Fatal(err)
	}
	cl.Close()

	long := make([]Hop, MaxChainDepth+1)
	for i := range long {
		long[i] = hopFor("x", a, pwAuth()...)
	}
	if _, err := d.Dial(long); err == nil {
		t.Fatal("over-long chain accepted")
	}
	if _, err := d.Dial(nil); err == nil {
		t.Fatal("empty chain accepted")
	}
}

func TestFailedSecondHopClosesFirst(t *testing.T) {
	bastion := startSrv(t)
	target := startSrv(t)
	d, _ := newDialer(t, true)
	_, err := d.Dial([]Hop{hopFor("bastion", bastion, pwAuth()...), hopFor("target", target, PasswordAuth("bad")...)})
	if err == nil || !strings.Contains(err.Error(), "target") {
		t.Fatalf("got %v", err)
	}
}

func TestKeepaliveDetectsDeadConnection(t *testing.T) {
	srv := startSrv(t)
	d, _ := newDialer(t, true)
	c, err := d.Dial([]Hop{hopFor("t", srv, pwAuth()...)})
	if err != nil {
		t.Fatal(err)
	}
	lost := make(chan struct{})
	stop := make(chan struct{})
	defer close(stop)
	go Keepalive(c, 30*time.Millisecond, 2, stop, func() { close(lost) })
	waitFor(t, "keepalives", func() bool { return srv.Keepalives() >= 2 })
	srv.DropConnections()
	select {
	case <-lost:
	case <-time.After(3 * time.Second):
		t.Fatal("lost connection not detected")
	}
}

func TestKeepaliveStopsOnSignal(t *testing.T) {
	srv := startSrv(t)
	d, _ := newDialer(t, true)
	c, _ := d.Dial([]Hop{hopFor("t", srv, pwAuth()...)})
	defer c.Close()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() { Keepalive(c, 20*time.Millisecond, 3, stop, nil); close(done) }()
	close(stop)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("keepalive ignored stop")
	}
}

func TestAgentAuthWithoutSocket(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "")
	if _, err := AgentAuth(); err == nil {
		t.Fatal("expected error without agent")
	}
}

func TestBatcherCoalescesAndPreservesOrder(t *testing.T) {
	var mu sync.Mutex
	var chunks [][]byte
	b := NewBatcher(30*time.Millisecond, 1<<20, func(p []byte) { mu.Lock(); chunks = append(chunks, p); mu.Unlock() })
	for i := 0; i < 100; i++ {
		b.Write([]byte{byte('a' + i%26)})
	}
	time.Sleep(120 * time.Millisecond)
	b.Write([]byte("tail"))
	b.Close()
	mu.Lock()
	defer mu.Unlock()
	if len(chunks) < 2 || len(chunks) > 4 {
		t.Fatalf("expected few coalesced chunks, got %d", len(chunks))
	}
	var all []byte
	for _, c := range chunks {
		all = append(all, c...)
	}
	if len(all) != 104 || !bytes.HasSuffix(all, []byte("tail")) || all[0] != 'a' || all[26] != 'a' {
		t.Fatalf("data lost or reordered: %q", all)
	}
}

func TestBatcherFlushesAtMaxBytes(t *testing.T) {
	n := 0
	b := NewBatcher(time.Hour, 10, func(p []byte) { n += len(p) })
	b.Write(bytes.Repeat([]byte("x"), 25))
	if n != 25 {
		t.Fatalf("flushed %d", n)
	}
	b.Close()
	b.Write([]byte("ignored"))
	if n != 25 {
		t.Fatal("write after close was delivered")
	}
}

func mustKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}
