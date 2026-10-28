package usecase

import (
	"os"
	"strings"
	"testing"

	"vvterm/internal/domain"
)

// runTest calls TestConnection in the background and answers the host key prompt.
func (h *harness) runTest(t *testing.T, host domain.Host, password, key string, trust bool) ConnectionTest {
	t.Helper()
	type res struct {
		r   ConnectionTest
		err error
	}
	ch := make(chan res, 1)
	go func() { r, err := h.app.Session.TestConnection(host, password, key); ch <- res{r, err} }()
	if trust {
		h.trust(t, key)
	}
	out := <-ch
	if out.err != nil {
		t.Fatalf("unexpected error: %v", out.err)
	}
	return out.r
}

func draft(port int, user string) domain.Host {
	return domain.Host{Hostname: "127.0.0.1", Port: port, Username: user}
}

func TestTestConnectionSucceedsWithTypedPasswordAndStoresNothing(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	hostsBefore, identsBefore := len(h.app.Host.ListHosts(domain.HostFilter{})), len(h.app.Vault.ListIdentities())

	r := h.runTest(t, draft(srv.Port(), "root"), "pw", "test-1", true)
	if !r.OK || !strings.HasPrefix(r.ServerVersion, "SSH-2.0") || r.Hops != 1 || !strings.Contains(r.Message, "root") {
		t.Fatalf("%+v", r)
	}
	if srv.Logins() != 1 {
		t.Fatalf("logins=%d", srv.Logins())
	}
	if len(h.app.Host.ListHosts(domain.HostFilter{})) != hostsBefore || len(h.app.Vault.ListIdentities()) != identsBefore {
		t.Fatal("testing a connection must not save hosts or identities")
	}
	if len(h.app.Forward.List()) != 0 || h.rec.count("term:ready:test-1") != 0 {
		t.Fatal("no session may be opened")
	}
}

func TestTestConnectionKnownHostSkipsPromptSecondTime(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	if r := h.runTest(t, draft(srv.Port(), "root"), "pw", "test-a", true); !r.OK {
		t.Fatalf("%+v", r)
	}
	r, err := h.app.Session.TestConnection(draft(srv.Port(), "root"), "pw", "test-b") // would block if it prompted
	if err != nil || !r.OK {
		t.Fatalf("%v %+v", err, r)
	}
	if h.rec.count("term:hostkey:test-b") != 0 {
		t.Fatal("trusted host prompted again")
	}
}

func TestTestConnectionWithSavedIdentity(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	saved := h.sshHost(t, "web", srv, "")
	d := draft(srv.Port(), "root")
	d.IdentityID = saved.IdentityID
	if r := h.runTest(t, d, "", "test-id", true); !r.OK {
		t.Fatalf("%+v", r)
	}
}

func TestTestConnectionWrongPasswordIsReportedNotLeaked(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	r := h.runTest(t, draft(srv.Port(), "root"), "S3CRET-wrong", "test-w", true)
	if r.OK || !strings.Contains(strings.ToLower(r.Message), "authentic") {
		t.Fatalf("%+v", r)
	}
	if strings.Contains(r.Message, "S3CRET-wrong") {
		t.Fatalf("password leaked into the message: %q", r.Message)
	}
}

func TestTestConnectionUnreachableHost(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	port := srv.Port()
	srv.Close()
	r, err := h.app.Session.TestConnection(draft(port, "root"), "pw", "test-u")
	if err != nil || r.OK || !strings.Contains(r.Message, "Cannot reach") {
		t.Fatalf("%v %+v", err, r)
	}
}

func TestTestConnectionRejectedHostKey(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	done := make(chan ConnectionTest, 1)
	go func() { r, _ := h.app.Session.TestConnection(draft(srv.Port(), "root"), "pw", "test-r"); done <- r }()
	h.rec.wait(t, "term:hostkey:test-r")
	if err := h.app.Session.TrustHostKey("test-r", ""); err != nil {
		t.Fatal(err)
	}
	r := <-done
	if r.OK || !strings.Contains(r.Message, "not trusted") || srv.Logins() != 0 {
		t.Fatalf("%+v logins=%d", r, srv.Logins())
	}
	if b, _ := os.ReadFile(h.core.Dialer.HostKeys.Path); len(b) != 0 {
		t.Fatalf("known_hosts must stay empty: %q", b)
	}
}

func TestTestConnectionThroughJumpHost(t *testing.T) {
	h := newHarness(t).unlocked(t)
	bastion, target := startServer(t), startServer(t)
	b := h.sshHost(t, "bastion", bastion, "")
	d := draft(target.Port(), "root")
	d.JumpHostID = b.ID
	type res struct{ r ConnectionTest }
	ch := make(chan res, 1)
	go func() { r, _ := h.app.Session.TestConnection(d, "pw", "test-j"); ch <- res{r} }()
	h.trust2(t, "test-j", 1) // bastion
	h.trust2(t, "test-j", 2) // target
	r := (<-ch).r
	if !r.OK || r.Hops != 2 || bastion.Logins() != 1 || target.Logins() != 1 {
		t.Fatalf("%+v bastion=%d target=%d", r, bastion.Logins(), target.Logins())
	}
}

func TestTestConnectionValidation(t *testing.T) {
	h := newHarness(t).unlocked(t)
	for name, c := range map[string]struct {
		host domain.Host
		pw   string
		key  string
	}{
		"no prompt key":    {draft(22, "u"), "p", ""},
		"bad hostname":     {domain.Host{Hostname: "a b", Port: 22, Username: "u"}, "p", "k"},
		"no hostname":      {domain.Host{Port: 22, Username: "u"}, "p", "k"},
		"no user, no cred": {domain.Host{Hostname: "h", Port: 22}, "", "k"},
		"password no user": {domain.Host{Hostname: "h", Port: 22}, "p", "k"},
		"unknown jump":     {domain.Host{Hostname: "h", Port: 22, Username: "u", JumpHostID: "nope"}, "p", "k"},
	} {
		if _, err := h.app.Session.TestConnection(c.host, c.pw, c.key); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestTestConnectionWithLockedVaultReportsIt(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	saved := h.sshHost(t, "web", srv, "")
	h.app.Vault.Lock()
	d := draft(srv.Port(), "root")
	d.IdentityID = saved.IdentityID
	r, err := h.app.Session.TestConnection(d, "", "test-l")
	if err != nil || r.OK || !strings.Contains(r.Message, "locked") {
		t.Fatalf("%v %+v", err, r)
	}
}
