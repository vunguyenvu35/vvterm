package usecase

import (
	"strings"
	"testing"
	"time"
)

func TestSessionFullLifecycle(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")

	sid, err := h.open(host.ID, 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	h.trust(t, sid)
	h.rec.wait(t, "term:ready:"+sid)
	h.rec.waitOutput(t, sid, "READY")

	if c, r := srv.LastWindow(); c != 100 || r != 30 {
		t.Fatalf("pty %dx%d", c, r)
	}
	if err := h.app.Session.Write(sid, "uptime\r"); err != nil {
		t.Fatal(err)
	}
	h.rec.waitOutput(t, sid, "ECHO:uptime")
	if err := h.app.Session.Resize(sid, 140, 50); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if c, r := srv.LastWindow(); c == 140 && r == 50 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if c, r := srv.LastWindow(); c != 140 || r != 50 {
		t.Fatalf("resize not applied: %dx%d", c, r)
	}

	h.app.Session.Write(sid, "exit\r")
	e := h.rec.wait(t, "term:closed:"+sid)
	if !e.data.(map[string]any)["clean"].(bool) {
		t.Fatalf("clean exit reported as failure: %v", e.data)
	}
	if err := h.app.Session.Close(sid); err != nil {
		t.Fatal(err)
	}
	if err := h.app.Session.Write(sid, "x"); err == nil {
		t.Fatal("write to closed session succeeded")
	}
}

func TestHostKeyConfirmationRules(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")

	sid, _ := h.open(host.ID, 80, 24)
	h.rec.wait(t, "term:hostkey:"+sid)
	if err := h.app.Session.TrustHostKey(sid, "SHA256:forged"); err == nil {
		t.Fatal("answer with a different fingerprint was accepted")
	}
	if err := h.app.Session.TrustHostKey("nonexistent", "SHA256:x"); err == nil {
		t.Fatal("answer for unknown prompt accepted")
	}
	// reject: empty fingerprint
	if err := h.app.Session.TrustHostKey(sid, ""); err != nil {
		t.Fatal(err)
	}
	e := h.rec.wait(t, "term:closed:"+sid)
	if r := e.data.(map[string]any)["reason"].(string); !strings.Contains(r, "not trusted") {
		t.Fatalf("reason: %q", r)
	}
	if srv.Logins() != 0 {
		t.Fatal("logged in to an untrusted host")
	}
}

func TestKnownHostSkipsPromptOnSecondSession(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	s1, _ := h.open(host.ID, 80, 24)
	h.trust(t, s1)
	h.rec.wait(t, "term:ready:"+s1)
	s2, _ := h.open(host.ID, 80, 24)
	h.rec.wait(t, "term:ready:"+s2)
	if _, ok := h.rec.find("term:hostkey:" + s2); ok {
		t.Fatal("second session prompted again for a trusted host")
	}
}

func TestSessionViaJumpHost(t *testing.T) {
	h := newHarness(t).unlocked(t)
	bastion, target := startServer(t), startServer(t)
	b := h.sshHost(t, "bastion", bastion, "")
	tg := h.sshHost(t, "target", target, b.ID)

	sid, err := h.open(tg.ID, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	h.trust(t, sid) // bastion key
	h.rec.waitOutputPrompt(t, h, sid)
	h.rec.waitOutput(t, sid, "READY")
	if target.Logins() != 1 || bastion.Logins() != 1 {
		t.Fatalf("logins bastion=%d target=%d", bastion.Logins(), target.Logins())
	}
}

// waitOutputPrompt answers a second host-key prompt (target) if it appears before output.
func (r *recorder) waitOutputPrompt(t *testing.T, h *harness, sid string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(r.output(sid), "READY") {
			return
		}
		if r.count("term:hostkey:"+sid) >= 2 {
			r.mu.Lock()
			var fp string
			n := 0
			for _, e := range r.events {
				if e.name == "term:hostkey:"+sid {
					n++
					if n == 2 {
						fp = e.data.(map[string]any)["fingerprint"].(string)
					}
				}
			}
			r.mu.Unlock()
			_ = h.app.Session.TrustHostKey(sid, fp)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLockedVaultBlocksConnection(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	h.app.Vault.Lock()
	sid, _ := h.open(host.ID, 80, 24)
	e := h.rec.wait(t, "term:closed:"+sid)
	if r := e.data.(map[string]any)["reason"].(string); !strings.Contains(r, "locked") {
		t.Fatalf("reason: %q", r)
	}
	h.rec.wait(t, "vault:locked")
}

func TestWrongPasswordReportsFailure(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	id, _ := h.app.Vault.AddPassword("bad", "root", "wrong")
	host, _ := h.app.Host.SaveHost(modelHost("web", srv.Port(), id.ID))
	sid, _ := h.open(host.ID, 80, 24)
	h.trust(t, sid)
	e := h.rec.wait(t, "term:closed:"+sid)
	if e.data.(map[string]any)["clean"].(bool) {
		t.Fatal("auth failure reported as clean")
	}
}

func TestConnectionLossAndManualReconnect(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	sid, _ := h.open(host.ID, 80, 24)
	h.trust(t, sid)
	h.rec.waitOutput(t, sid, "READY")

	srv.DropConnections()
	e := h.rec.wait(t, "term:closed:"+sid)
	if e.data.(map[string]any)["clean"].(bool) {
		t.Fatal("dropped link reported as clean")
	}
	// terminal content is the frontend's; the backend must not reconnect by itself
	time.Sleep(200 * time.Millisecond)
	if srv.Logins() != 1 {
		t.Fatalf("auto-reconnected: logins=%d", srv.Logins())
	}
	if err := h.app.Session.Reconnect(sid, 80, 24); err != nil {
		t.Fatal(err)
	}
	h.rec.waitCount(t, "term:ready:"+sid, 2)
	if srv.Logins() != 2 {
		t.Fatalf("logins=%d after reconnect", srv.Logins())
	}
	if err := h.app.Session.Reconnect(sid, 80, 24); err == nil {
		t.Fatal("reconnect of a live session accepted")
	}
}

func TestOpenUnknownHostAndBadSize(t *testing.T) {
	h := newHarness(t).unlocked(t)
	if _, err := h.open("nope", 80, 24); err == nil {
		t.Fatal("unknown host accepted")
	}
	if err := h.app.Session.Resize("nope", 80, 24); err == nil {
		t.Fatal("unknown session accepted")
	}
	if err := h.app.Session.Resize("x", 0, 0); err == nil {
		t.Fatal("zero size accepted")
	}
}

func TestCloseWhileWaitingForHostKeyCancelsConnect(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	sid, _ := h.open(host.ID, 80, 24)
	h.rec.wait(t, "term:hostkey:"+sid)
	if err := h.app.Session.Close(sid); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if srv.Logins() != 0 {
		t.Fatal("connection continued after the tab was closed")
	}
}

func TestOutputIsBatchedIntoFewEvents(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	sid, _ := h.open(host.ID, 80, 24)
	h.trust(t, sid)
	h.rec.waitOutput(t, sid, "READY")
	for i := 0; i < 50; i++ {
		h.app.Session.Write(sid, "line\r")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && strings.Count(h.rec.output(sid), "ECHO:line") < 50 {
		time.Sleep(10 * time.Millisecond)
	}
	if n := strings.Count(h.rec.output(sid), "ECHO:line"); n != 50 {
		t.Fatalf("only %d echoes", n)
	}
	if ev := h.rec.count("term:data:" + sid); ev >= 50 {
		t.Fatalf("no batching: %d events for 50 lines", ev)
	}
}

func TestAttachReplaysStateAndBuffersOutput(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")

	// The "frontend" is slow to subscribe: everything happens before Attach.
	sid, _ := h.app.Session.Open(host.ID, 80, 24)
	h.trust(t, sid)
	h.rec.wait(t, "term:ready:"+sid)
	time.Sleep(100 * time.Millisecond) // let the READY banner arrive
	if strings.Contains(h.rec.output(sid), "READY") {
		t.Fatal("output was emitted before Attach; it must be buffered")
	}
	before := h.rec.count("term:ready:" + sid)
	if err := h.app.Session.Attach(sid); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(h.rec.output(sid), "READY") {
		t.Fatal("buffered output not delivered on Attach")
	}
	if h.rec.count("term:ready:"+sid) != before+1 {
		t.Fatal("ready state not replayed")
	}
	// after Attach, output streams live
	h.app.Session.Write(sid, "hello\r")
	h.rec.waitOutput(t, sid, "ECHO:hello")
	if err := h.app.Session.Attach("nope"); err == nil {
		t.Fatal("attach to unknown session accepted")
	}
}

func TestAttachReplaysPendingHostKeyPrompt(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	sid, _ := h.app.Session.Open(host.ID, 80, 24)
	defer h.app.Session.Close(sid)
	h.rec.wait(t, "term:hostkey:"+sid)
	if err := h.app.Session.Attach(sid); err != nil {
		t.Fatal(err)
	}
	if h.rec.count("term:hostkey:"+sid) != 2 {
		t.Fatalf("prompt not replayed: %d", h.rec.count("term:hostkey:"+sid))
	}
}

func TestAttachReplaysClosedState(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "w", srv, "")
	h.app.Vault.Lock()
	sid, _ := h.app.Session.Open(host.ID, 80, 24)
	h.rec.wait(t, "term:closed:"+sid)
	h.app.Session.Attach(sid)
	if h.rec.count("term:closed:"+sid) != 2 {
		t.Fatal("closed state not replayed")
	}
}
