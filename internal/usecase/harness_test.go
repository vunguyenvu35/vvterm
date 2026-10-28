package usecase

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"golang.org/x/crypto/ssh"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"vvterm/internal/sftpx"
	"vvterm/internal/sqlitedb"
	"vvterm/internal/sshx"
	"vvterm/internal/store"

	"vvterm/internal/domain"
	"vvterm/internal/testssh"
	"vvterm/internal/vault"
)

const masterPW = "a long master password"

type event struct {
	name string
	data any
}

type recorder struct {
	mu     sync.Mutex
	events []event
}

func (r *recorder) emit(name string, data ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var d any
	if len(data) > 0 {
		d = data[0]
	}
	r.events = append(r.events, event{name, d})
}

func (r *recorder) find(name string) (event, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.events {
		if e.name == name {
			return e, true
		}
	}
	return event{}, false
}

func (r *recorder) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.events {
		if e.name == name {
			n++
		}
	}
	return n
}

func (r *recorder) wait(t *testing.T, name string) event {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if e, ok := r.find(name); ok {
			return e
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for event %q; got %v", name, r.names())
	return event{}
}

func (r *recorder) names() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n []string
	for _, e := range r.events {
		n = append(n, e.name)
	}
	return n
}

// output concatenates every term:data:<sid> payload.
func (r *recorder) output(sid string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var sb strings.Builder
	for _, e := range r.events {
		if e.name == "term:data:"+sid {
			b, _ := base64.StdEncoding.DecodeString(e.data.(string))
			sb.Write(b)
		}
	}
	return sb.String()
}

func (r *recorder) waitOutput(t *testing.T, sid, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(r.output(sid), want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for output %q, got %q", want, r.output(sid))
}

type harness struct {
	core *Core
	app  *Services
	rec  *recorder
}

// testCore builds a Core on real adapters (JSON store + vault with a cheap KDF and an in-memory keychain).
func testCore(t *testing.T, dir string, emit Emitter) (*Core, error) {
	t.Helper()
	data := filepath.Join(dir, "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		return nil, err
	}
	db, err := sqlitedb.Open(filepath.Join(data, "vvterm.db"))
	if err != nil {
		return nil, err
	}
	t.Cleanup(func() { db.Close() })
	st, err := store.OpenWith(db.StorePersister())
	if err != nil {
		return nil, err
	}
	v, err := vault.NewWith(db.VaultPersister(), data, vault.NewMemKeychain())
	if err != nil {
		return nil, err
	}
	v.SetKDF(vault.KDFParams{Memory: 64, Time: 1, Threads: 1})
	return NewCore(dir, Options{Store: st, Vault: v, Emit: emit,
		OpenRemoteFS: func(c *sshx.Client) (RemoteFS, error) { return sftpx.Open(c.Client) }})
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	rec := &recorder{}
	core, err := testCore(t, t.TempDir(), rec.emit)
	if err != nil {
		t.Fatal(err)
	}
	return &harness{core: core, app: New(core), rec: rec}
}

func (h *harness) unlocked(t *testing.T) *harness {
	t.Helper()
	if err := h.app.Vault.Create(masterPW); err != nil {
		t.Fatal(err)
	}
	return h
}

// sshHost registers a password identity + host that points at a testssh server.
func (h *harness) sshHost(t *testing.T, label string, srv *testssh.Server, jump string) domain.Host {
	t.Helper()
	id, err := h.app.Vault.AddPassword("pw-"+label, "root", "pw")
	if err != nil {
		t.Fatal(err)
	}
	host, err := h.app.Host.SaveHost(domain.Host{Label: label, Hostname: "127.0.0.1", Port: srv.Port(), Username: "root",
		IdentityID: id.ID, JumpHostID: jump, KeepaliveSec: 1})
	if err != nil {
		t.Fatal(err)
	}
	return host
}

func startServer(t *testing.T) *testssh.Server {
	t.Helper()
	s, err := testssh.Start(testssh.Config{User: "root", Password: "pw"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

// trust answers the host key prompt for sid with the displayed fingerprint.
func (h *harness) trust(t *testing.T, key string) {
	t.Helper()
	e := h.rec.wait(t, "term:hostkey:"+key)
	fp := e.data.(map[string]any)["fingerprint"].(string)
	if err := h.app.Session.TrustHostKey(key, fp); err != nil {
		t.Fatal(err)
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(fmt.Sprint(err))
	}
	return v
}

func modelHost(label string, port int, identityID string) domain.Host {
	return domain.Host{Label: label, Hostname: "127.0.0.1", Port: port, Username: "root", IdentityID: identityID, KeepaliveSec: 1}
}

// waitCount waits until at least n events with the given name were recorded.
func (r *recorder) waitCount(t *testing.T, name string, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if r.count(name) >= n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %d x %q (have %d)", n, name, r.count(name))
}

func mustEd25519() (ed25519.PrivateKey, ed25519.PublicKey) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	return priv, pub
}

func pemEncode(b *pem.Block) []byte { return pem.EncodeToMemory(b) }

func startKeyServer(t *testing.T, pk ssh.PublicKey) (*testssh.Server, error) {
	t.Helper()
	s, err := testssh.Start(testssh.Config{User: "root", AuthKeys: []ssh.PublicKey{pk}})
	if err == nil {
		t.Cleanup(s.Close)
	}
	return s, err
}

// open mimics the frontend: open a session, then Attach straight away.
func (h *harness) open(hostID string, cols, rows int) (string, error) {
	sid, err := h.app.Session.Open(hostID, cols, rows)
	if err == nil {
		err = h.app.Session.Attach(sid)
	}
	return sid, err
}

// trust2 answers the n-th host key prompt recorded for key (jump chains prompt once per machine).
func (h *harness) trust2(t *testing.T, key string, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.rec.mu.Lock()
		seen := 0
		var fp string
		for _, e := range h.rec.events {
			if e.name == "term:hostkey:"+key {
				seen++
				if seen == n {
					fp = e.data.(map[string]any)["fingerprint"].(string)
				}
			}
		}
		h.rec.mu.Unlock()
		if seen >= n {
			if err := h.app.Session.TrustHostKey(key, fp); err != nil {
				t.Fatal(err)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("prompt #%d for %s never appeared", n, key)
}

// lastEvent returns the most recent event with the given name.
func (r *recorder) lastEvent(name string) event {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.events) - 1; i >= 0; i-- {
		if r.events[i].name == name {
			return r.events[i]
		}
	}
	return event{}
}
