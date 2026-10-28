package sqlitedb

import (
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/store"
	"vvterm/internal/vault"
)

func open(t *testing.T) (*DB, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "sub", "vvterm.db")
	d, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d, p
}

func sample() domain.Data {
	now := time.Date(2026, 3, 4, 5, 6, 7, 123456789, time.UTC)
	del := now.Add(time.Hour)
	return domain.Data{
		Version: 1,
		Groups:  []domain.Group{{Meta: domain.Meta{ID: "g1", UpdatedAt: now}, Name: "prod", ParentID: "", Color: "#f00", SortOrder: 3}},
		Hosts: []domain.Host{
			{Meta: domain.Meta{ID: "h1", UpdatedAt: now}, Label: "web", GroupID: "g1", Hostname: "w.example", Port: 2222, Username: "ops",
				IdentityID: "i1", JumpHostID: "h2", Env: domain.EnvProd, Tags: []string{"a", "b"}, KeepaliveSec: 15, CreatedAt: now},
			{Meta: domain.Meta{ID: "h2", UpdatedAt: del, DeletedAt: &del}, Label: "gone", Hostname: "g", Port: 22, KeepaliveSec: 30, CreatedAt: now},
		},
		Identities: []domain.Identity{{Meta: domain.Meta{ID: "i1", UpdatedAt: now}, Name: "k", Username: "ops", AuthType: domain.AuthKey, SecretRef: "s1", PublicKey: "ssh-ed25519 AAA"}},
		Snippets:   []domain.Snippet{{Meta: domain.Meta{ID: "s1", UpdatedAt: now}, Label: "Docker clean", Description: "stop and prune", Script: "docker stop $(docker ps -aq)\ndocker system prune -af\n"}},
		Forwards: []domain.PortForward{{Meta: domain.Meta{ID: "f1", UpdatedAt: now}, HostID: "h1", Type: domain.ForwardLocal, BindAddr: "127.0.0.1",
			BindPort: 3306, DestHost: "db", DestPort: 3306, AutoStart: true, AllowPublicBind: true}},
	}
}

func TestStoreDataRoundTripPreservesEverything(t *testing.T) {
	d, p := open(t)
	sp := d.StorePersister()
	if _, found, err := sp.Load(); err != nil || found {
		t.Fatalf("fresh db: found=%v err=%v", found, err)
	}
	in := sample()
	if err := sp.Save(in); err != nil {
		t.Fatal(err)
	}
	d.Close()
	d2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	out, found, err := d2.StorePersister().Load()
	if err != nil || !found {
		t.Fatalf("found=%v err=%v", found, err)
	}
	if !reflect.DeepEqual(in.Groups, out.Groups) || !reflect.DeepEqual(in.Snippets, out.Snippets) || !reflect.DeepEqual(in.Identities, out.Identities) || !reflect.DeepEqual(in.Forwards, out.Forwards) {
		t.Fatalf("mismatch\n in=%+v\nout=%+v", in, out)
	}
	if len(out.Hosts) != 2 || out.Hosts[0].Tags[1] != "b" || out.Hosts[1].DeletedAt == nil || !out.Hosts[1].DeletedAt.Equal(*in.Hosts[1].DeletedAt) {
		t.Fatalf("hosts: %+v", out.Hosts)
	}
	if !out.Hosts[0].CreatedAt.Equal(in.Hosts[0].CreatedAt) || out.Hosts[0].Port != 2222 || out.Hosts[0].Env != domain.EnvProd {
		t.Fatalf("host fields: %+v", out.Hosts[0])
	}
}

func TestSaveIsAtomicOnFailure(t *testing.T) {
	d, _ := open(t)
	sp := d.StorePersister()
	if err := sp.Save(sample()); err != nil {
		t.Fatal(err)
	}
	bad := sample()
	bad.Hosts = append(bad.Hosts, bad.Hosts[0]) // duplicate primary key
	if err := sp.Save(bad); err == nil {
		t.Fatal("duplicate id accepted")
	}
	out, _, _ := sp.Load()
	if len(out.Hosts) != 2 || len(out.Groups) != 1 {
		t.Fatalf("failed save corrupted data: %+v", out)
	}
}

func TestStoreRunsOnSQLite(t *testing.T) {
	d, p := open(t)
	s, err := store.OpenWith(d.StorePersister())
	if err != nil {
		t.Fatal(err)
	}
	g, _ := s.SaveGroup(domain.Group{Name: "g"})
	h, err := s.SaveHost(domain.Host{Hostname: "10.0.0.1", Username: "u", GroupID: g.ID, Tags: []string{"x"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveForward(domain.PortForward{HostID: h.ID, Type: domain.ForwardDynamic}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteHost(h.ID); err != nil {
		t.Fatal(err)
	}
	d.Close()

	d2, _ := Open(p)
	defer d2.Close()
	s2, err := store.OpenWith(d2.StorePersister())
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.ListHosts(domain.HostFilter{})) != 0 || len(s2.ListForwards("")) != 0 {
		t.Fatal("deleted records visible after reopen")
	}
	snap := s2.Snapshot()
	if len(snap.Hosts) != 1 || snap.Hosts[0].DeletedAt == nil {
		t.Fatalf("tombstone lost: %+v", snap.Hosts)
	}
}

func TestVaultRunsOnSQLiteAndSharesTheFile(t *testing.T) {
	d, p := open(t)
	kdf := vault.KDFParams{Memory: 64, Time: 1, Threads: 1}
	v, err := vault.NewWith(d.VaultPersister(), "acct", vault.NewMemKeychain())
	if err != nil {
		t.Fatal(err)
	}
	v.SetKDF(kdf)
	if v.Status().Exists {
		t.Fatal("fresh db has no vault")
	}
	if err := v.Create("a long master password"); err != nil {
		t.Fatal(err)
	}
	id, err := v.AddSecret(domain.SecretPassword, []byte("hunter2"))
	if err != nil {
		t.Fatal(err)
	}
	// the store uses the same database concurrently
	s, _ := store.OpenWith(d.StorePersister())
	if _, err := s.SaveHost(domain.Host{Hostname: "h"}); err != nil {
		t.Fatal(err)
	}
	d.Close()

	d2, _ := Open(p)
	defer d2.Close()
	v2, err := vault.NewWith(d2.VaultPersister(), "acct", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !v2.Status().Exists {
		t.Fatal("vault not persisted")
	}
	if err := v2.Unlock("wrong password here"); err != vault.ErrBadPassword {
		t.Fatalf("got %v", err)
	}
	if err := v2.Unlock("a long master password"); err != nil {
		t.Fatal(err)
	}
	if got, err := v2.GetSecret(id); err != nil || string(got) != "hunter2" {
		t.Fatalf("%q %v", got, err)
	}
	// deletion keeps a tombstone without ciphertext
	if err := v2.DeleteSecret(id); err != nil {
		t.Fatal(err)
	}
	sec := v2.Secrets()
	if len(sec) != 1 || sec[0].DeletedAt == nil || len(sec[0].Ciphertext) != 0 {
		t.Fatalf("%+v", sec)
	}
}

func TestDatabaseFileHoldsNoPlaintextSecrets(t *testing.T) {
	d, p := open(t)
	v, _ := vault.NewWith(d.VaultPersister(), "a", nil)
	v.SetKDF(vault.KDFParams{Memory: 64, Time: 1, Threads: 1})
	_ = v.Create("a long master password")
	_, _ = v.AddSecret(domain.SecretPrivateKey, []byte("PLAINTEXT-MARKER-XYZ"))
	d.Close()
	for _, f := range []string{p, p + "-wal"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		if contains(b, "PLAINTEXT-MARKER-XYZ") || contains(b, "a long master password") {
			t.Fatalf("plaintext found in %s", f)
		}
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("db perm %v", st.Mode().Perm())
	}
}

func contains(b []byte, s string) bool { return len(b) >= len(s) && indexOf(b, s) >= 0 }

func indexOf(b []byte, s string) int {
	for i := 0; i+len(s) <= len(b); i++ {
		if string(b[i:i+len(s)]) == s {
			return i
		}
	}
	return -1
}

func TestMigrationVersionAndNewerSchemaRejected(t *testing.T) {
	d, p := open(t)
	var v int
	if err := d.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil || v != schemaVersion {
		t.Fatalf("user_version=%d err=%v", v, err)
	}
	if _, err := d.db.Exec(`PRAGMA user_version = 99`); err != nil {
		t.Fatal(err)
	}
	d.Close()
	if _, err := Open(p); err == nil {
		t.Fatal("database from a newer app version was opened")
	}
}

func TestReopenIsIdempotent(t *testing.T) {
	d, p := open(t)
	d.Close()
	for i := 0; i < 3; i++ {
		x, err := Open(p)
		if err != nil {
			t.Fatal(err)
		}
		x.Close()
	}
}

// A database created by v1.0 (schema v1, no snippets table) must upgrade in place without losing data.
func TestUpgradeFromSchemaV1KeepsData(t *testing.T) {
	p := filepath.Join(t.TempDir(), "old.db")
	raw, err := sql.Open("sqlite", "file:"+p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(migrations[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO hosts(id,label,hostname,port,created_at,updated_at) VALUES('h1','legacy','10.0.0.1',22,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	d, err := Open(p)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	defer d.Close()
	var v int
	_ = d.db.QueryRow(`PRAGMA user_version`).Scan(&v)
	if v != schemaVersion {
		t.Fatalf("user_version=%d want %d", v, schemaVersion)
	}
	data, found, err := d.StorePersister().Load()
	if err != nil || !found || len(data.Hosts) != 1 || data.Hosts[0].Label != "legacy" {
		t.Fatalf("data lost in upgrade: %v %v %+v", err, found, data.Hosts)
	}
	data.Snippets = []domain.Snippet{{Meta: domain.Meta{ID: "s", UpdatedAt: time.Now()}, Label: "x", Script: "ls"}}
	if err := d.StorePersister().Save(data); err != nil {
		t.Fatalf("snippets table unusable after upgrade: %v", err)
	}
}

// A v2 database (hosts without a server type, forwards without a label) upgrades in place, and the new
// columns round-trip.
func TestUpgradeFromSchemaV2AddsServerTypeAndForwardLabel(t *testing.T) {
	p := filepath.Join(t.TempDir(), "v2.db")
	raw, err := sql.Open("sqlite", "file:"+p)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:2] {
		if _, err := raw.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.Exec(`INSERT INTO hosts(id,label,hostname,port,created_at,updated_at) VALUES('h1','legacy','10.0.0.1',22,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO port_forwards(id,host_id,type,bind_addr,bind_port,updated_at) VALUES('f1','h1','dynamic','127.0.0.1',1080,'2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`PRAGMA user_version = 2`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	d, err := Open(p)
	if err != nil {
		t.Fatalf("upgrade failed: %v", err)
	}
	defer d.Close()
	data, _, err := d.StorePersister().Load()
	if err != nil || len(data.Hosts) != 1 || data.Hosts[0].OS != "" || len(data.Forwards) != 1 || data.Forwards[0].Label != "" {
		t.Fatalf("%v %+v %+v", err, data.Hosts, data.Forwards)
	}
	data.Hosts[0].OS = "debian"
	data.Forwards[0].Label = "SOCKS to prod"
	if err := d.StorePersister().Save(data); err != nil {
		t.Fatal(err)
	}
	again, _, err := d.StorePersister().Load()
	if err != nil || again.Hosts[0].OS != "debian" || again.Forwards[0].Label != "SOCKS to prod" {
		t.Fatalf("not persisted: %v %+v %+v", err, again.Hosts, again.Forwards)
	}
}

func TestHostTelnetAndThemeRoundTrip(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	now := time.Now()
	data := domain.Data{Hosts: []domain.Host{
		{Meta: domain.Meta{ID: "a", UpdatedAt: now}, Label: "switch", Hostname: "10.0.0.2", Port: 22, CreatedAt: now, TelnetEnabled: true, TelnetPort: 2323, TerminalTheme: "dracula", OS: "linux"},
		{Meta: domain.Meta{ID: "b", UpdatedAt: now}, Label: "plain", Hostname: "10.0.0.3", Port: 22, CreatedAt: now},
	}}
	if err := d.StorePersister().Save(data); err != nil {
		t.Fatal(err)
	}
	got, _, err := d.StorePersister().Load()
	if err != nil || len(got.Hosts) != 2 {
		t.Fatalf("%v %+v", err, got.Hosts)
	}
	a, b := got.Hosts[0], got.Hosts[1]
	if !a.TelnetEnabled || a.TelnetPort != 2323 || a.TerminalTheme != "dracula" || a.OS != "linux" {
		t.Fatalf("%+v", a)
	}
	if b.TelnetEnabled || b.TelnetPort != 0 || b.TerminalTheme != "" {
		t.Fatalf("%+v", b)
	}
}

func TestIdentityCertificateRoundTrips(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	now := time.Now()
	data := domain.Data{Identities: []domain.Identity{
		{Meta: domain.Meta{ID: "i1", UpdatedAt: now}, Name: "with", AuthType: domain.AuthKey, Certificate: "ssh-ed25519-cert-v01@openssh.com AAAA"},
		{Meta: domain.Meta{ID: "i2", UpdatedAt: now}, Name: "without", AuthType: domain.AuthPassword},
	}}
	if err := d.StorePersister().Save(data); err != nil {
		t.Fatal(err)
	}
	got, _, err := d.StorePersister().Load()
	if err != nil || len(got.Identities) != 2 || got.Identities[0].Certificate == "" || got.Identities[1].Certificate != "" {
		t.Fatalf("%v %+v", err, got.Identities)
	}
}

// Regression: a database that an intermediate build had already taken to "v3" had only some of the later
// additions, and the app refused to open it ("no such column: telnet_enabled"). The newer steps are
// "add what is missing", so such a database is completed instead.
func TestADatabaseThatStoppedHalfWayIsCompletedOnOpen(t *testing.T) {
	p := filepath.Join(t.TempDir(), "half.db")
	raw, err := sql.Open("sqlite", "file:"+p)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations {
		if _, err := raw.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	// what the first v3 contained: the server type and the rule name, nothing else
	if _, err := raw.Exec(`ALTER TABLE hosts ADD COLUMN os TEXT NOT NULL DEFAULT ''; ALTER TABLE port_forwards ADD COLUMN label TEXT NOT NULL DEFAULT '';`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO hosts(id,label,hostname,port,os,created_at,updated_at) VALUES('h1','kept','10.0.0.1',22,'ubuntu','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`PRAGMA user_version = 3`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	d, err := Open(p)
	if err != nil {
		t.Fatalf("must open: %v", err)
	}
	defer d.Close()
	var v int
	_ = d.db.QueryRow(`PRAGMA user_version`).Scan(&v)
	if v != schemaVersion {
		t.Fatalf("user_version=%d want %d", v, schemaVersion)
	}
	data, found, err := d.StorePersister().Load()
	if err != nil || !found || len(data.Hosts) != 1 || data.Hosts[0].Label != "kept" || data.Hosts[0].OS != "ubuntu" {
		t.Fatalf("data lost: %v %v %+v", err, found, data.Hosts)
	}
	data.Hosts[0].TelnetEnabled, data.Hosts[0].TelnetPort, data.Hosts[0].TerminalTheme = true, 23, "nord"
	data.Identities = []domain.Identity{{Meta: domain.Meta{ID: "i", UpdatedAt: time.Now()}, Name: "n", AuthType: domain.AuthKey, Certificate: "c"}}
	if err := d.StorePersister().Save(data); err != nil {
		t.Fatalf("the new columns must be usable: %v", err)
	}
	if err := d.ActivityLog().Add(domain.ActivityEntry{Kind: domain.ActConnect, Message: "x", OK: true}); err != nil {
		t.Fatalf("the activity table must exist: %v", err)
	}
}

func TestEveryAdditionIsPresentOnAFreshDatabaseAndTheStepCanRunTwice(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "fresh.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	for _, a := range additions {
		var n int
		if err := d.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, a.table, a.column).Scan(&n); err != nil || n != 1 {
			t.Errorf("%s.%s: %d %v", a.table, a.column, n, err)
		}
	}
	tx, err := d.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := ensureAdditions(tx); err != nil {
		t.Fatalf("running it again must change nothing: %v", err)
	}
}
