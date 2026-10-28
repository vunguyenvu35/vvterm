package importer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vvterm/internal/domain"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

const sample = `
# global defaults
Host *
    ServerAliveInterval 60

Host bastion
    HostName bastion.example.com
    User ops
    IdentityFile "~/.ssh/id_bastion"

Host db1 db2
    HostName 10.0.0.5
    Port 2222
    User dba
    ProxyJump bastion
    LocalForward 3306 127.0.0.1:3306
    LocalForward 127.0.0.1:6379 cache.internal:6379
    RemoteForward 9000 localhost:9000
    DynamicForward 1080

Host app
    ProxyJump ops@jump1.example.com:2200,bastion
    ProxyCommand ssh -W %h:%p x
    Port notanumber
`

func TestParseBasicBlocksAndWildcards(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "config"), sample)
	p, err := ParseFile(filepath.Join(dir, "config"))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Entries) != 4 {
		t.Fatalf("entries %d: %+v", len(p.Entries), p.Entries)
	}
	by := map[string]Entry{}
	for _, e := range p.Entries {
		by[e.Alias] = e
	}
	b := by["bastion"]
	if b.HostName != "bastion.example.com" || b.User != "ops" || !strings.HasSuffix(b.IdentityFile, "/.ssh/id_bastion") || strings.Contains(b.IdentityFile, "~") {
		t.Fatalf("bastion: %+v", b)
	}
	d := by["db1"]
	if d.Port != 2222 || len(d.Local) != 2 || len(d.Remote) != 1 || len(d.Dynamic) != 1 || d.ProxyJump[0] != "bastion" {
		t.Fatalf("db1: %+v", d)
	}
	if by["db2"].HostName != "10.0.0.5" {
		t.Fatalf("multi-alias Host line must share settings: %+v", by["db2"])
	}
	if d.Local[1].BindAddr != "127.0.0.1" || d.Local[1].DestHost != "cache.internal" || d.Local[1].DestPort != 6379 {
		t.Fatalf("forward parse: %+v", d.Local[1])
	}
	w := strings.Join(p.Warnings, "\n")
	for _, want := range []string{"ProxyCommand", "invalid Port", "wildcard"} {
		if !strings.Contains(w, want) {
			t.Errorf("missing warning %q in:\n%s", want, w)
		}
	}
}

func TestIncludeGroupsByFileNameAndLoops(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "config"), "Include config.d/*\nHost solo\n  HostName solo.example\n")
	write(t, filepath.Join(dir, "config.d", "vl24h-prod"), "Host web1\n  HostName 1.1.1.1\n")
	write(t, filepath.Join(dir, "config.d", "staging.conf"), "Host web2\n  HostName 2.2.2.2\n")
	write(t, filepath.Join(dir, "config.d", "loop"), "Include ../config\nHost lp\n  HostName 3.3.3.3\n")
	p, err := ParseFile(filepath.Join(dir, "config"))
	if err != nil {
		t.Fatal(err)
	}
	src := map[string]string{}
	for _, e := range p.Entries {
		src[e.Alias] = e.Source
	}
	if src["web1"] != "vl24h-prod" || src["web2"] != "staging" || src["solo"] != "config" || src["lp"] != "loop" {
		t.Fatalf("sources: %v", src)
	}
	if !strings.Contains(strings.Join(p.Warnings, "|"), "include loop") {
		t.Fatalf("loop not reported: %v", p.Warnings)
	}
}

func TestParseMissingFile(t *testing.T) {
	if _, err := ParseFile(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseMetaComment(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "config"), "# vvterm: env=prod tags=a,b\nHost x\n  HostName x\nHost y\n  HostName y\n")
	p, _ := ParseFile(filepath.Join(dir, "config"))
	if p.Entries[0].Env != "prod" || len(p.Entries[0].Tags) != 2 || p.Entries[1].Env != "" {
		t.Fatalf("%+v", p.Entries)
	}
}

func TestParseJumpSpec(t *testing.T) {
	cases := []struct {
		in, user, host string
		port           int
	}{
		{"bastion", "", "bastion", 22},
		{"ops@bastion", "ops", "bastion", 22},
		{"ops@bastion:2200", "ops", "bastion", 2200},
		{"[::1]:2200", "", "::1", 2200},
	}
	for _, c := range cases {
		u, h, p := ParseJumpSpec(c.in)
		if u != c.user || h != c.host || p != c.port {
			t.Errorf("%s -> %q %q %d", c.in, u, h, p)
		}
	}
}

func TestBuildPlanJumpsForwardsGroups(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "config"), "Include config.d/*\n")
	write(t, filepath.Join(dir, "config.d", "prod"), sample)
	parsed, err := ParseFile(filepath.Join(dir, "config"))
	if err != nil {
		t.Fatal(err)
	}
	plan := Build(parsed, domain.Data{}, PolicySkip)

	if len(plan.Groups) != 1 || plan.Groups[0].Name != "prod" {
		t.Fatalf("groups: %+v", plan.Groups)
	}
	byLabel := map[string]domain.Host{}
	byID := map[string]domain.Host{}
	for _, h := range plan.Hosts {
		byLabel[h.Label] = h
		byID[h.ID] = h
		if h.ID == "" {
			t.Fatalf("host without id: %+v", h)
		}
	}
	db := byLabel["db1"]
	if byID[db.JumpHostID].Label != "bastion" {
		t.Fatalf("db1 jump: %+v", db)
	}
	// app: ProxyJump ops@jump1:2200,bastion => app -> bastion -> jump1
	app := byLabel["app"]
	if byID[app.JumpHostID].Label != "bastion" {
		t.Fatalf("app should jump via bastion last: %+v", app)
	}
	bastion := byLabel["bastion"]
	j1 := byID[bastion.JumpHostID]
	if j1.Hostname != "jump1.example.com" || j1.Port != 2200 || j1.Username != "ops" {
		t.Fatalf("implicit jump host wrong: %+v (bastion=%+v)", j1, bastion)
	}
	if byLabel["db2"].Hostname != "10.0.0.5" || byLabel["db1"].GroupID != plan.Groups[0].ID {
		t.Fatal("group/hostname mapping wrong")
	}
	if len(plan.Forwards) != 8 { // db1 and db2: 2 local + 1 remote + 1 dynamic each
		t.Fatalf("forwards: %d", len(plan.Forwards))
	}
	for _, f := range plan.Forwards {
		if f.BindAddr != "127.0.0.1" || f.AllowPublicBind {
			t.Fatalf("default bind must be loopback: %+v", f)
		}
	}
	if plan.KeyFiles[bastion.ID] == "" {
		t.Fatal("bastion IdentityFile not recorded")
	}
}

func TestPublicForwardBindIsFlagged(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "config"), "Host a\n  HostName a\n  LocalForward *:8080 x:80\n")
	p, _ := ParseFile(filepath.Join(dir, "config"))
	plan := Build(p, domain.Data{}, PolicySkip)
	f := plan.Forwards[0]
	if f.BindAddr != "0.0.0.0" || !f.AllowPublicBind {
		t.Fatalf("%+v", f)
	}
	if !strings.Contains(strings.Join(plan.Warnings, "|"), "explicit in config") {
		t.Fatal("no warning for public bind")
	}
}

func TestConflictPolicies(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "config"), "Host web\n  HostName new.example.com\n")
	p, _ := ParseFile(filepath.Join(dir, "config"))
	old := domain.Host{Meta: domain.Meta{ID: "old-id"}, Label: "web", Hostname: "old.example.com", Port: 22}
	existing := domain.Data{Hosts: []domain.Host{old}}

	skip := Build(p, existing, PolicySkip)
	if len(skip.Hosts) != 0 || len(skip.Skipped) != 1 {
		t.Fatalf("skip: %+v", skip)
	}
	ow := Build(p, existing, PolicyOverwrite)
	if len(ow.Hosts) != 1 || ow.Hosts[0].ID != "old-id" || ow.Hosts[0].Hostname != "new.example.com" {
		t.Fatalf("overwrite: %+v", ow.Hosts)
	}
	dup := Build(p, existing, PolicyDuplicate)
	if len(dup.Hosts) != 1 || dup.Hosts[0].ID == "old-id" || dup.Hosts[0].Label != "web (2)" || dup.Hosts[0].Hostname != "new.example.com" {
		t.Fatalf("duplicate: %+v", dup.Hosts)
	}
}

func TestJumpToExistingHostReusesIt(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "config"), "Host app\n  HostName app\n  ProxyJump bastion\n")
	p, _ := ParseFile(filepath.Join(dir, "config"))
	existing := domain.Data{Hosts: []domain.Host{{Meta: domain.Meta{ID: "b-id"}, Label: "bastion", Hostname: "bastion", Port: 22}}}
	plan := Build(p, existing, PolicySkip)
	if len(plan.Hosts) != 1 || plan.Hosts[0].JumpHostID != "b-id" {
		t.Fatalf("%+v", plan.Hosts)
	}
}
