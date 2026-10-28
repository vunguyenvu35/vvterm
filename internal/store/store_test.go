package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vvterm/internal/domain"
)

func open(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func mustHost(t *testing.T, s *Store, h domain.Host) domain.Host {
	t.Helper()
	out, err := s.SaveHost(h)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSaveHostDefaultsAndPersistence(t *testing.T) {
	s, dir := open(t)
	h := mustHost(t, s, domain.Host{Hostname: "10.0.0.1", Username: "root"})
	if h.ID == "" || h.Port != 22 || h.Label != "10.0.0.1" || h.KeepaliveSec != 30 {
		t.Fatalf("defaults wrong: %+v", h)
	}
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s2.GetHost(h.ID)
	if err != nil || got.Hostname != "10.0.0.1" {
		t.Fatalf("not persisted: %v %+v", err, got)
	}
	st, _ := os.Stat(filepath.Join(dir, "hosts.json"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", st.Mode().Perm())
	}
}

func TestSaveHostValidation(t *testing.T) {
	s, _ := open(t)
	cases := map[string]domain.Host{
		"no hostname":   {},
		"bad port":      {Hostname: "x", Port: 70000},
		"bad env":       {Hostname: "x", Env: "qa"},
		"missing group": {Hostname: "x", GroupID: "nope"},
		"missing ident": {Hostname: "x", IdentityID: "nope"},
		"missing jump":  {Hostname: "x", JumpHostID: "nope"},
	}
	for name, h := range cases {
		if _, err := s.SaveHost(h); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestUpdateKeepsCreatedAtAndBumpsUpdatedAt(t *testing.T) {
	s, _ := open(t)
	clk := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.SetClock(func() time.Time { return clk })
	h := mustHost(t, s, domain.Host{Hostname: "a"})
	clk = clk.Add(time.Hour)
	h.Label = "renamed"
	h2 := mustHost(t, s, h)
	if !h2.CreatedAt.Equal(h.CreatedAt) || !h2.UpdatedAt.After(h.UpdatedAt) {
		t.Fatalf("created %v updated %v", h2.CreatedAt, h2.UpdatedAt)
	}
	if len(s.ListHosts(domain.HostFilter{})) != 1 {
		t.Fatal("update created a duplicate")
	}
}

func TestDeleteIsTombstone(t *testing.T) {
	s, _ := open(t)
	h := mustHost(t, s, domain.Host{Hostname: "a"})
	if err := s.DeleteHost(h.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetHost(h.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	if len(s.ListHosts(domain.HostFilter{})) != 0 {
		t.Fatal("deleted host listed")
	}
	snap := s.Snapshot()
	if len(snap.Hosts) != 1 || snap.Hosts[0].DeletedAt == nil {
		t.Fatalf("tombstone missing from snapshot: %+v", snap.Hosts)
	}
	if err := s.DeleteHost(h.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("double delete: %v", err)
	}
}

func TestFilterAndSearch(t *testing.T) {
	s, _ := open(t)
	g, _ := s.SaveGroup(domain.Group{Name: "prod"})
	mustHost(t, s, domain.Host{Label: "web-1", Hostname: "w1.example.com", Env: domain.EnvProd, GroupID: g.ID, Tags: []string{"nginx", "edge"}})
	mustHost(t, s, domain.Host{Label: "db-1", Hostname: "db1.internal", Env: domain.EnvStaging, Tags: []string{"mariadb"}})
	mustHost(t, s, domain.Host{Label: "dev-box", Hostname: "10.1.1.1", Username: "alice", Env: domain.EnvDev})

	check := func(f domain.HostFilter, want int) {
		t.Helper()
		if got := len(s.ListHosts(f)); got != want {
			t.Errorf("%+v: got %d want %d", f, got, want)
		}
	}
	check(domain.HostFilter{}, 3)
	check(domain.HostFilter{Query: "WEB"}, 1)
	check(domain.HostFilter{Query: "alice"}, 1)
	check(domain.HostFilter{Query: "mariadb"}, 1)
	check(domain.HostFilter{Env: domain.EnvProd}, 1)
	check(domain.HostFilter{GroupID: g.ID}, 1)
	check(domain.HostFilter{Tag: "EDGE"}, 1)
	check(domain.HostFilter{Query: "zzz"}, 0)
}

func TestGroupCycleAndDeleteReparent(t *testing.T) {
	s, _ := open(t)
	a, _ := s.SaveGroup(domain.Group{Name: "a"})
	b, _ := s.SaveGroup(domain.Group{Name: "b", ParentID: a.ID})
	c, _ := s.SaveGroup(domain.Group{Name: "c", ParentID: b.ID})
	a.ParentID = c.ID
	if _, err := s.SaveGroup(a); err == nil {
		t.Fatal("cycle accepted")
	}
	a.ParentID = a.ID
	if _, err := s.SaveGroup(a); err == nil {
		t.Fatal("self-parent accepted")
	}
	h := mustHost(t, s, domain.Host{Hostname: "x", GroupID: b.ID})
	if err := s.DeleteGroup(b.ID); err != nil {
		t.Fatal(err)
	}
	gotH, _ := s.GetHost(h.ID)
	if gotH.GroupID != a.ID {
		t.Fatalf("host not moved to parent: %q", gotH.GroupID)
	}
	for _, g := range s.ListGroups() {
		if g.ID == c.ID && g.ParentID != a.ID {
			t.Fatalf("child group not reparented: %q", g.ParentID)
		}
	}
	if _, err := s.SaveGroup(domain.Group{Name: " "}); err == nil {
		t.Fatal("blank name accepted")
	}
}

func TestJumpChainAndLoops(t *testing.T) {
	s, _ := open(t)
	bastion := mustHost(t, s, domain.Host{Hostname: "bastion"})
	mid := mustHost(t, s, domain.Host{Hostname: "mid", JumpHostID: bastion.ID})
	target := mustHost(t, s, domain.Host{Hostname: "target", JumpHostID: mid.ID})

	chain, err := s.JumpChain(target.ID)
	if err != nil || len(chain) != 3 || chain[0].ID != bastion.ID || chain[2].ID != target.ID {
		t.Fatalf("chain wrong: %v %+v", err, chain)
	}
	bastion.JumpHostID = target.ID
	if _, err := s.SaveHost(bastion); err == nil {
		t.Fatal("loop accepted")
	}
	self := bastion
	self.JumpHostID = bastion.ID
	if _, err := s.SaveHost(self); err == nil {
		t.Fatal("self jump accepted")
	}
}

func TestJumpChainDepthLimit(t *testing.T) {
	s, _ := open(t)
	prev := ""
	var last domain.Host
	for i := 0; i < MaxJumpDepth+2; i++ {
		var err error
		last, err = s.SaveHost(domain.Host{Hostname: "h", JumpHostID: prev})
		if err != nil {
			if i < MaxJumpDepth {
				t.Fatalf("rejected too early at %d: %v", i, err)
			}
			return
		}
		prev = last.ID
	}
	if _, err := s.JumpChain(last.ID); err == nil {
		t.Fatal("over-deep chain accepted")
	}
}

func TestDeleteHostClearsJumpAndForwards(t *testing.T) {
	s, _ := open(t)
	bastion := mustHost(t, s, domain.Host{Hostname: "bastion"})
	t1 := mustHost(t, s, domain.Host{Hostname: "t", JumpHostID: bastion.ID})
	if _, err := s.SaveForward(domain.PortForward{HostID: bastion.ID, Type: domain.ForwardDynamic}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteHost(bastion.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetHost(t1.ID)
	if got.JumpHostID != "" {
		t.Fatal("dangling jump_host_id")
	}
	if len(s.ListForwards("")) != 0 {
		t.Fatal("forward of deleted host still listed")
	}
}

func TestForwardValidationAndDefaults(t *testing.T) {
	s, _ := open(t)
	h := mustHost(t, s, domain.Host{Hostname: "x"})
	if _, err := s.SaveForward(domain.PortForward{HostID: h.ID, Type: domain.ForwardLocal, BindPort: 3306}); err == nil {
		t.Fatal("local forward without destination accepted")
	}
	if _, err := s.SaveForward(domain.PortForward{HostID: h.ID, Type: "weird"}); err == nil {
		t.Fatal("bad type accepted")
	}
	if _, err := s.SaveForward(domain.PortForward{HostID: "nope", Type: domain.ForwardDynamic}); err == nil {
		t.Fatal("unknown host accepted")
	}
	f, err := s.SaveForward(domain.PortForward{HostID: h.ID, Type: domain.ForwardLocal, BindPort: 3306, DestHost: "db", DestPort: 3306})
	if err != nil {
		t.Fatal(err)
	}
	if f.BindAddr != "127.0.0.1" {
		t.Fatalf("default bind must be loopback, got %q", f.BindAddr)
	}
}

func TestIdentityDeleteBlockedWhileInUse(t *testing.T) {
	s, _ := open(t)
	id, _ := s.SaveIdentity(domain.Identity{Name: "k", AuthType: domain.AuthKey})
	h := mustHost(t, s, domain.Host{Hostname: "x", IdentityID: id.ID})
	if err := s.DeleteIdentity(id.ID); err == nil {
		t.Fatal("deleted identity in use")
	}
	_ = s.DeleteHost(h.ID)
	if err := s.DeleteIdentity(id.ID); err != nil {
		t.Fatal(err)
	}
}

func TestReplaceAndSnapshotAreIsolated(t *testing.T) {
	s, _ := open(t)
	mustHost(t, s, domain.Host{Hostname: "a", Tags: []string{"t"}})
	snap := s.Snapshot()
	snap.Hosts[0].Tags[0] = "mutated"
	if s.Snapshot().Hosts[0].Tags[0] != "t" {
		t.Fatal("snapshot aliases internal state")
	}
	if err := s.Replace(domain.Data{}); err != nil {
		t.Fatal(err)
	}
	if len(s.ListHosts(domain.HostFilter{})) != 0 {
		t.Fatal("replace did not clear")
	}
}

func TestCorruptFileIsReportedNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "hosts.json")
	_ = os.WriteFile(p, []byte("{not json"), 0o600)
	if _, err := Open(dir); err == nil {
		t.Fatal("corrupt hosts.json accepted")
	}
	b, _ := os.ReadFile(p)
	if string(b) != "{not json" {
		t.Fatal("corrupt file was modified")
	}
}

func TestAtomicWriteLeavesNoTempFiles(t *testing.T) {
	s, dir := open(t)
	for i := 0; i < 5; i++ {
		mustHost(t, s, domain.Host{Hostname: "h"})
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if e.Name() != "hosts.json" {
			t.Fatalf("stray file %s", e.Name())
		}
	}
}

func TestPublicBindRequiresExplicitOptIn(t *testing.T) {
	s, _ := open(t)
	h := mustHost(t, s, domain.Host{Hostname: "x"})
	f := domain.PortForward{HostID: h.ID, Type: domain.ForwardDynamic, BindAddr: "0.0.0.0", BindPort: 1080}
	if _, err := s.SaveForward(f); err == nil {
		t.Fatal("0.0.0.0 accepted without opt-in")
	}
	f.AllowPublicBind = true
	if _, err := s.SaveForward(f); err != nil {
		t.Fatalf("opt-in rejected: %v", err)
	}
	for _, a := range []string{"127.0.0.1", "::1", "localhost"} {
		if _, err := s.SaveForward(domain.PortForward{HostID: h.ID, Type: domain.ForwardDynamic, BindAddr: a}); err != nil {
			t.Errorf("loopback %s rejected: %v", a, err)
		}
	}
}

func TestHostnameWithControlCharsRejected(t *testing.T) {
	s, _ := open(t)
	for _, h := range []domain.Host{
		{Hostname: "a\nProxyCommand x"}, {Hostname: "a b"}, {Hostname: "a", Username: "u\r\nx"},
	} {
		if _, err := s.SaveHost(h); err == nil {
			t.Errorf("accepted %+v", h)
		}
	}
}

func TestSnippetsCRUDSortingAndTombstones(t *testing.T) {
	s, dir := open(t)
	b, err := s.SaveSnippet(domain.Snippet{Label: "b-second", Script: "echo b"})
	if err != nil {
		t.Fatal(err)
	}
	a, _ := s.SaveSnippet(domain.Snippet{Label: "A-first", Script: "echo a", Description: "says a"})
	if got := s.ListSnippets(); len(got) != 2 || got[0].ID != a.ID || got[1].ID != b.ID {
		t.Fatalf("not sorted case-insensitively: %+v", got)
	}
	a.Script = "echo changed"
	if _, err := s.SaveSnippet(a); err != nil || len(s.ListSnippets()) != 2 {
		t.Fatalf("update created a duplicate: %v", err)
	}
	if _, err := s.SaveSnippet(domain.Snippet{Label: "", Script: "x"}); err == nil {
		t.Fatal("invalid snippet saved")
	}
	if err := s.DeleteSnippet(b.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSnippet(b.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("double delete: %v", err)
	}
	if snap := s.Snapshot(); len(snap.Snippets) != 2 || snap.Snippets[1].DeletedAt == nil && snap.Snippets[0].DeletedAt == nil {
		t.Fatalf("tombstone missing: %+v", snap.Snippets)
	}
	s2, _ := Open(dir)
	if got := s2.ListSnippets(); len(got) != 1 || got[0].Script != "echo changed" {
		t.Fatalf("not persisted: %+v", got)
	}
}

func TestSetHostOSKeepsTheRestAndSurvivesAnEditWithoutIt(t *testing.T) {
	s, _ := open(t)
	h, err := s.SaveHost(domain.Host{Label: "web", Hostname: "10.0.0.1", Username: "root"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetHostOS(h.ID, "ubuntu"); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetHost(h.ID)
	if got.OS != "ubuntu" || got.Label != "web" || !got.UpdatedAt.After(h.UpdatedAt) && !got.UpdatedAt.Equal(h.UpdatedAt) {
		t.Fatalf("%+v", got)
	}
	// the edit form does not know the OS: saving without it must not erase it
	edit := got
	edit.OS = ""
	edit.Label = "web-renamed"
	saved, err := s.SaveHost(edit)
	if err != nil || saved.OS != "ubuntu" || saved.Label != "web-renamed" {
		t.Fatalf("%+v %v", saved, err)
	}
	if err := s.SetHostOS(h.ID, "plan9"); err == nil {
		t.Fatal("an unknown os must be refused")
	}
	if err := s.SetHostOS("missing", "debian"); err == nil {
		t.Fatal("an unknown host must be refused")
	}
}
