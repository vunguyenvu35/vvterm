package usecase

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/domain"
	"vvterm/internal/vault"
)

func echoLn(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				l, err := bufio.NewReader(c).ReadString('\n')
				if err == nil {
					c.Write([]byte("echo:" + l))
				}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func ask(t *testing.T, addr string) string {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	c.Write([]byte("hi\n"))
	l, _ := bufio.NewReader(c).ReadString('\n')
	return l
}

// ---- forwards ----

func TestForwardOnDedicatedConnection(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "bastion", srv, "")
	dest := echoLn(t)
	f, err := h.app.Forward.SaveForward(domain.PortForward{HostID: host.ID, Type: domain.ForwardLocal, BindPort: 0, DestHost: "127.0.0.1", DestPort: dest})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- h.app.Forward.Start(f.ID) }()
	h.trust(t, "fwd-"+f.ID)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	st := h.app.Forward.List()
	if len(st) != 1 || st[0].State != "running" || st[0].Addr == "" {
		t.Fatalf("%+v", st)
	}
	if got := ask(t, st[0].Addr); got != "echo:hi\n" {
		t.Fatalf("got %q", got)
	}
	if err := h.app.Forward.Start(f.ID); err == nil {
		t.Fatal("double start accepted")
	}
	if err := h.app.Forward.Stop(f.ID); err != nil {
		t.Fatal(err)
	}
	if h.app.Forward.List()[0].State != "stopped" {
		t.Fatal("not stopped")
	}
	if _, err := net.DialTimeout("tcp", st[0].Addr, 300*time.Millisecond); err == nil {
		t.Fatal("port still open after stop")
	}
	if err := h.app.Forward.Stop(f.ID); err == nil {
		t.Fatal("stopping a stopped forward should report an error")
	}
	if h.rec.count("forward:state") < 2 {
		t.Fatal("forward:state events missing")
	}
}

func TestForwardAutoStartRidesSessionAndDiesWithIt(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "bastion", srv, "")
	dest := echoLn(t)
	f, _ := h.app.Forward.SaveForward(domain.PortForward{HostID: host.ID, Type: domain.ForwardLocal, DestHost: "127.0.0.1", DestPort: dest, AutoStart: true})

	sid, _ := h.open(host.ID, 80, 24)
	h.trust(t, sid)
	h.rec.wait(t, "term:ready:"+sid)
	var addr string
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if l := h.app.Forward.List(); len(l) == 1 && l[0].State == "running" {
			addr = l[0].Addr
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if addr == "" {
		t.Fatal("auto_start forward did not come up")
	}
	if got := ask(t, addr); got != "echo:hi\n" {
		t.Fatalf("got %q", got)
	}
	if srv.Logins() != 1 {
		t.Fatalf("forward opened its own connection: logins=%d", srv.Logins())
	}
	// manual Start while it is running on the session is refused
	if err := h.app.Forward.Start(f.ID); err == nil {
		t.Fatal("start of a running forward accepted")
	}
	h.app.Session.Close(sid)
	if l := h.app.Forward.List()[0]; l.State != "stopped" {
		t.Fatalf("forward outlived its session: %+v", l)
	}
	if _, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
		t.Fatal("port still open after session close")
	}
}

func TestAutoStartForwardIsRebuiltAfterReconnect(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "bastion", srv, "")
	dest := echoLn(t)
	h.app.Forward.SaveForward(domain.PortForward{HostID: host.ID, Type: domain.ForwardLocal, DestHost: "127.0.0.1", DestPort: dest, AutoStart: true})
	sid, _ := h.open(host.ID, 80, 24)
	h.trust(t, sid)
	h.rec.waitCount(t, "term:ready:"+sid, 1)
	srv.DropConnections()
	h.rec.wait(t, "term:closed:"+sid)
	// poll until the forward is reported stopped (session teardown)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && h.app.Forward.List()[0].State == "running" {
		time.Sleep(10 * time.Millisecond)
	}
	if h.app.Forward.List()[0].State == "running" {
		t.Fatal("forward still running after link loss")
	}
	if err := h.app.Session.Reconnect(sid, 80, 24); err != nil {
		t.Fatal(err)
	}
	h.rec.waitCount(t, "term:ready:"+sid, 2)
	l := h.app.Forward.List()[0]
	if l.State != "running" {
		t.Fatalf("auto_start forward not rebuilt: %+v", l)
	}
	if got := ask(t, l.Addr); got != "echo:hi\n" {
		t.Fatalf("got %q", got)
	}
}

func TestDeleteForwardStopsIt(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "b", srv, "")
	f, _ := h.app.Forward.SaveForward(domain.PortForward{HostID: host.ID, Type: domain.ForwardDynamic})
	go h.app.Forward.Start(f.ID)
	h.trust(t, "fwd-"+f.ID)
	h.rec.waitCount(t, "forward:state", 1)
	if err := h.app.Forward.DeleteForward(f.ID); err != nil {
		t.Fatal(err)
	}
	if len(h.app.Forward.List()) != 0 {
		t.Fatal("forward still listed")
	}
}

func TestForwardErrorStateIsReported(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "b", srv, "")
	busy, _ := net.Listen("tcp", "127.0.0.1:0")
	defer busy.Close()
	f, _ := h.app.Forward.SaveForward(domain.PortForward{HostID: host.ID, Type: domain.ForwardDynamic, BindPort: busy.Addr().(*net.TCPAddr).Port})
	done := make(chan error, 1)
	go func() { done <- h.app.Forward.Start(f.ID) }()
	h.trust(t, "fwd-"+f.ID)
	if err := <-done; err == nil {
		t.Fatal("expected bind error")
	}
	if l := h.app.Forward.List()[0]; l.State != "error" || l.Error == "" {
		t.Fatalf("%+v", l)
	}
}

// ---- vault service ----

func TestVaultServiceLifecycleAndLockEvent(t *testing.T) {
	h := newHarness(t)
	v := h.app.Vault
	if st := v.Status(); st.Exists || st.Unlocked {
		t.Fatalf("%+v", st)
	}
	if err := v.Create("short"); err == nil {
		t.Fatal("weak password accepted")
	}
	if err := v.Create(masterPW); err != nil {
		t.Fatal(err)
	}
	v.Lock()
	h.rec.wait(t, "vault:locked")
	if err := v.Unlock("wrong wrong wrong"); err == nil {
		t.Fatal("wrong password accepted")
	}
	if err := v.Unlock(masterPW); err != nil {
		t.Fatal(err)
	}
	if err := v.ChangePassword(masterPW, "a brand new password"); err != nil {
		t.Fatal(err)
	}
	if err := v.SetAutoLock(-1); err == nil {
		t.Fatal("negative auto-lock accepted")
	}
	if err := v.SetAutoLock(5); err != nil || v.Status().AutoLockMinutes != 5 {
		t.Fatalf("%v %+v", err, v.Status())
	}
	if err := v.EnableBiometric(); err != nil {
		t.Fatal(err)
	}
	v.Lock()
	if err := v.UnlockBiometric(); err != nil {
		t.Fatal(err)
	}
	// auto-lock setting persists across restart
	core2, err := testCore(t, h.core.Dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if core2.settings.AutoLockMinutes != 5 {
		t.Fatalf("settings not persisted: %+v", core2.settings)
	}
}

func TestIdentitiesNeverExposeSecrets(t *testing.T) {
	h := newHarness(t).unlocked(t)
	v := h.app.Vault
	pw, err := v.AddPassword("db", "dba", "SUPER-SECRET-PW")
	if err != nil {
		t.Fatal(err)
	}
	gen, err := v.GenerateKey("deploy", "ed25519")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(gen.PublicKey, "ssh-ed25519 ") {
		t.Fatalf("public key: %q", gen.PublicKey)
	}
	pub, err := v.PublicKey(gen.ID)
	if err != nil || pub != gen.PublicKey {
		t.Fatalf("%q %v", pub, err)
	}
	if _, err := v.PublicKey(pw.ID); err == nil {
		t.Fatal("password identity has no public key")
	}
	if _, err := v.GenerateKey("rsa", "rsa"); err == nil {
		t.Fatal("unsupported type accepted")
	}
	for _, id := range v.ListIdentities() {
		blob := id.Name + id.Username + id.PublicKey + id.SecretRef
		if strings.Contains(blob, "SUPER-SECRET-PW") || strings.Contains(blob, "PRIVATE KEY") {
			t.Fatalf("identity leaks secret: %+v", id)
		}
	}
	// the secret ref is an opaque vault id; hosts that use it block deletion
	host, _ := h.app.Host.SaveHost(domain.Host{Hostname: "x", IdentityID: pw.ID})
	if err := v.DeleteIdentity(pw.ID); err == nil {
		t.Fatal("deleted identity in use")
	}
	h.app.Host.DeleteHost(host.ID)
	if err := v.DeleteIdentity(pw.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.core.Vault.GetSecret(pw.SecretRef); err == nil {
		t.Fatal("secret survived identity deletion")
	}
}

func TestLockedVaultRefusesSecretOperations(t *testing.T) {
	h := newHarness(t).unlocked(t)
	h.app.Vault.Lock()
	if _, err := h.app.Vault.AddPassword("x", "u", "p"); err == nil {
		t.Fatal("AddPassword on locked vault")
	}
	if _, err := h.app.Vault.GenerateKey("x", ""); err == nil {
		t.Fatal("GenerateKey on locked vault")
	}
	if _, err := h.app.Vault.AddKeyPEM("x", "pem", ""); err == nil {
		t.Fatal("AddKeyPEM on locked vault")
	}
}

func TestAddKeyFromFileWithPassphrase(t *testing.T) {
	h := newHarness(t).unlocked(t)
	// encrypted key
	raw, _ := mustEd25519()
	blk, err := ssh.MarshalPrivateKeyWithPassphrase(raw, "k", []byte("pass phrase"))
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "id")
	os.WriteFile(p, pemEncode(blk), 0o600)

	if _, err := h.app.Vault.AddKey("enc", p, ""); err == nil || !strings.Contains(err.Error(), "passphrase") {
		t.Fatalf("expected passphrase error, got %v", err)
	}
	if _, err := h.app.Vault.AddKey("enc", p, "wrong"); err == nil {
		t.Fatal("wrong passphrase accepted")
	}
	id, err := h.app.Vault.AddKey("enc", p, "pass phrase")
	if err != nil {
		t.Fatal(err)
	}
	// stored decrypted: usable without a passphrase later
	pemStored, _ := h.core.Vault.GetSecret(id.SecretRef)
	if _, err := vault.ParsePrivateKey(pemStored, nil); err != nil {
		t.Fatalf("stored key unusable: %v", err)
	}
	if _, err := h.app.Vault.AddKey("missing", filepath.Join(t.TempDir(), "nope"), ""); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestSessionWithGeneratedKeyIdentity(t *testing.T) {
	h := newHarness(t).unlocked(t)
	id, _ := h.app.Vault.GenerateKey("k", "ed25519")
	pk, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(id.PublicKey))
	srv, _ := startKeyServer(t, pk)
	host, _ := h.app.Host.SaveHost(modelHost("keyed", srv.Port(), id.ID))
	sid, _ := h.open(host.ID, 80, 24)
	h.trust(t, sid)
	h.rec.waitOutput(t, sid, "READY")
}

// ---- import / export ----

func TestImportSSHConfigWithKeysAndConflicts(t *testing.T) {
	h := newHarness(t).unlocked(t)
	dir := t.TempDir()
	priv, _, _ := vault.GenerateEd25519("t")
	keyPath := filepath.Join(dir, "id_ed25519")
	os.WriteFile(keyPath, priv, 0o600)
	os.MkdirAll(filepath.Join(dir, "config.d"), 0o700)
	os.WriteFile(filepath.Join(dir, "config"), []byte("Include config.d/*\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "config.d", "vl24h-prod"), []byte(
		"Host bastion\n  HostName b.example.com\n  User ops\n  IdentityFile "+keyPath+"\n"+
			"Host db\n  HostName 10.0.0.5\n  User dba\n  ProxyJump bastion\n  IdentityFile "+keyPath+"\n  LocalForward 3306 127.0.0.1:3306\n"), 0o600)

	rep, err := h.app.ImportExp.ImportSSHConfig(filepath.Join(dir, "config"), "skip")
	if err != nil {
		t.Fatal(err)
	}
	if rep.HostsAdded != 2 || rep.GroupsAdded != 1 || rep.ForwardsAdded != 1 || rep.KeysImported != 1 {
		t.Fatalf("%+v", rep)
	}
	hosts := h.app.Host.ListHosts(domain.HostFilter{})
	if len(hosts) != 2 {
		t.Fatalf("%+v", hosts)
	}
	for _, x := range hosts {
		if x.IdentityID == "" || x.GroupID == "" {
			t.Fatalf("host missing identity/group: %+v", x)
		}
	}
	if len(h.app.Vault.ListIdentities()) != 1 {
		t.Fatal("the shared key file should map to one identity")
	}
	// second import with skip: nothing new
	rep2, _ := h.app.ImportExp.ImportSSHConfig(filepath.Join(dir, "config"), "skip")
	if rep2.HostsAdded != 0 || len(rep2.Skipped) != 2 {
		t.Fatalf("%+v", rep2)
	}
	rep3, _ := h.app.ImportExp.ImportSSHConfig(filepath.Join(dir, "config"), "duplicate")
	if rep3.HostsAdded != 2 || len(h.app.Host.ListHosts(domain.HostFilter{})) != 4 {
		t.Fatalf("%+v", rep3)
	}
	if _, err := h.app.ImportExp.ImportSSHConfig(filepath.Join(dir, "config"), "bogus"); err == nil {
		t.Fatal("bad policy accepted")
	}
	if _, err := h.app.ImportExp.ImportSSHConfig(filepath.Join(dir, "none"), "skip"); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestImportWithLockedVaultStillImportsHosts(t *testing.T) {
	h := newHarness(t).unlocked(t)
	h.app.Vault.Lock()
	dir := t.TempDir()
	priv, _, _ := vault.GenerateEd25519("t")
	os.WriteFile(filepath.Join(dir, "k"), priv, 0o600)
	os.WriteFile(filepath.Join(dir, "config"), []byte("Host a\n  HostName a\n  IdentityFile "+filepath.Join(dir, "k")+"\n"), 0o600)
	rep, err := h.app.ImportExp.ImportSSHConfig(filepath.Join(dir, "config"), "skip")
	if err != nil {
		t.Fatal(err)
	}
	if rep.HostsAdded != 1 || rep.KeysImported != 0 || !strings.Contains(strings.Join(rep.Warnings, "|"), "locked") {
		t.Fatalf("%+v", rep)
	}
}

func TestExportSSHConfigKeysOptIn(t *testing.T) {
	h := newHarness(t).unlocked(t)
	id, _ := h.app.Vault.GenerateKey("k", "ed25519")
	h.app.Host.SaveHost(domain.Host{Label: "a", Hostname: "a", IdentityID: id.ID, Username: "u"})

	out := t.TempDir()
	rep, err := h.app.ImportExp.ExportSSHConfig(out, false)
	if err != nil || len(rep.KeyFiles) != 0 {
		t.Fatalf("%v %+v", err, rep)
	}
	rep, err = h.app.ImportExp.ExportSSHConfig(t.TempDir(), true)
	if err != nil || len(rep.KeyFiles) != 1 {
		t.Fatalf("%v %+v", err, rep)
	}
	body, _ := os.ReadFile(rep.KeyFiles[0])
	if _, err := vault.ParsePrivateKey(body, nil); err != nil {
		t.Fatalf("exported key invalid: %v", err)
	}
	h.app.Vault.Lock()
	if _, err := h.app.ImportExp.ExportSSHConfig(t.TempDir(), true); err == nil {
		t.Fatal("key export with locked vault")
	}
	if _, err := h.app.ImportExp.ExportSSHConfig("", false); err == nil {
		t.Fatal("empty dir accepted")
	}
}

func TestBackupExportImportIntoFreshInstall(t *testing.T) {
	a := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := a.sshHost(t, "web", srv, "")
	backup := filepath.Join(t.TempDir(), "backup.vvbak")
	if err := a.app.ImportExp.ExportBackup(backup, "short"); err == nil {
		t.Fatal("short backup password accepted")
	}
	if err := a.app.ImportExp.ExportBackup(backup, "backup-password"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(backup)
	if strings.Contains(string(raw), "127.0.0.1") {
		t.Fatal("backup not encrypted")
	}

	b := newHarness(t).unlocked(t) // different vault & master password key
	if err := b.app.ImportExp.ImportBackup(backup, "wrong-password"); err == nil {
		t.Fatal("wrong backup password accepted")
	}
	if err := b.app.ImportExp.ImportBackup(backup, "backup-password"); err != nil {
		t.Fatal(err)
	}
	got, err := b.app.Host.GetHost(host.ID)
	if err != nil || got.Label != "web" {
		t.Fatalf("%v %+v", err, got)
	}
	// restored identity works for a real connection
	sid, _ := b.open(host.ID, 80, 24)
	b.trust(t, sid)
	b.rec.waitOutput(t, sid, "READY")

	b.app.Vault.Lock()
	if err := b.app.ImportExp.ImportBackup(backup, "backup-password"); err == nil {
		t.Fatal("import into locked vault")
	}
}

func TestExportPlainJSONHasNoSecrets(t *testing.T) {
	h := newHarness(t).unlocked(t)
	id, _ := h.app.Vault.AddPassword("p", "u", "TOPSECRET")
	h.app.Host.SaveHost(domain.Host{Label: "a", Hostname: "a.example", IdentityID: id.ID})
	p := filepath.Join(t.TempDir(), "hosts.json")
	if err := h.app.ImportExp.ExportPlainJSON(p); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if strings.Contains(string(b), "TOPSECRET") || strings.Contains(string(b), id.SecretRef) {
		t.Fatalf("secret material in plain export:\n%s", b)
	}
	if !strings.Contains(string(b), "a.example") {
		t.Fatal("hosts missing")
	}
}

// ---- sync ----

func bareRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git missing")
	}
	d := filepath.Join(t.TempDir(), "r.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", "-b", "main", d).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	return d
}

func TestSyncTwoMachinesEndToEnd(t *testing.T) {
	remote := bareRepo(t)
	a := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := a.sshHost(t, "shared-host", srv, "")

	if st := a.app.Sync.Status(); st.Configured {
		t.Fatal("sync should start unconfigured")
	}
	if err := a.app.Sync.SyncNow(); err == nil {
		t.Fatal("sync without configuration accepted")
	}
	if err := a.app.Sync.Configure(remote); err != nil {
		t.Fatal(err)
	}
	if err := a.app.Sync.SyncNow(); err != nil {
		t.Fatal(err)
	}
	if st := a.app.Sync.Status(); !st.Configured || st.LastSync.IsZero() || st.LastError != "" {
		t.Fatalf("%+v", st)
	}

	// brand new machine: join with the master password
	b := newHarness(t)
	if err := b.app.Sync.Configure(remote); err != nil {
		t.Fatal(err)
	}
	if err := b.app.Sync.JoinExisting("wrong password here"); err == nil {
		t.Fatal("wrong password joined")
	}
	if err := b.app.Sync.JoinExisting(masterPW); err != nil {
		t.Fatal(err)
	}
	if got, err := b.app.Host.GetHost(host.ID); err != nil || got.Label != "shared-host" {
		t.Fatalf("%v %+v", err, got)
	}
	sid, _ := b.open(host.ID, 80, 24)
	b.trust(t, sid)
	b.rec.waitOutput(t, sid, "READY") // secret travelled and decrypts on machine B

	// edits on B reach A; delete on A reaches B
	nh, _ := b.app.Host.SaveHost(domain.Host{Label: "from-b", Hostname: "b.example"})
	if err := b.app.Sync.SyncNow(); err != nil {
		t.Fatal(err)
	}
	a.app.Host.DeleteHost(host.ID)
	if err := a.app.Sync.SyncNow(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.app.Host.GetHost(nh.ID); err != nil {
		t.Fatalf("A did not receive B's host: %v", err)
	}
	if err := b.app.Sync.SyncNow(); err != nil {
		t.Fatal(err)
	}
	if _, err := b.app.Host.GetHost(host.ID); err == nil {
		t.Fatal("deletion did not reach B")
	}
	if err := b.app.Sync.JoinExisting(masterPW); err == nil {
		t.Fatal("join on a machine that already has a vault")
	}
}

func TestSyncRequiresUnlockedVaultAndRepoWithBundle(t *testing.T) {
	remote := bareRepo(t)
	h := newHarness(t).unlocked(t)
	h.app.Sync.Configure(remote)
	h.app.Vault.Lock()
	if err := h.app.Sync.SyncNow(); err == nil {
		t.Fatal("sync with locked vault")
	}
	if st := h.app.Sync.Status(); st.LastError == "" {
		t.Fatal("error not recorded in status")
	}
	empty := newHarness(t)
	empty.app.Sync.Configure(remote)
	if err := empty.app.Sync.JoinExisting(masterPW); err == nil {
		t.Fatal("join of an empty repo")
	}
	if err := h.app.Sync.Configure(""); err == nil {
		t.Fatal("empty URL accepted")
	}
}

// ---- settings ----

func TestSettingsValidationAndPersistence(t *testing.T) {
	h := newHarness(t)
	s := h.app.Settings
	if g := s.Get(); g.Theme != "dark" || g.FontSize != 13 {
		t.Fatalf("defaults: %+v", g)
	}
	if _, err := s.Save(Settings{Theme: "neon", FontSize: 13}); err == nil {
		t.Fatal("bad theme")
	}
	if _, err := s.Save(Settings{Theme: "dark", FontSize: 2}); err == nil {
		t.Fatal("bad font size")
	}
	if _, err := s.Save(Settings{Theme: "light", FontSize: 16}); err != nil {
		t.Fatal(err)
	}
	c2, err := testCore(t, h.core.Dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c2.settings.Theme != "light" || c2.settings.FontSize != 16 {
		t.Fatalf("%+v", c2.settings)
	}
}

// Regression: Go nil slices marshal to JSON null, which crashed the UI (".length of null").
func TestReportsNeverMarshalNullSlices(t *testing.T) {
	h := newHarness(t).unlocked(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "config"), []byte("Host a\n  HostName a\n"), 0o600)
	rep, err := h.app.ImportExp.ImportSSHConfig(filepath.Join(dir, "config"), "skip")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(rep)
	if strings.Contains(string(b), "null") {
		t.Fatalf("import report contains null: %s", b)
	}
	er, err := h.app.ImportExp.ExportSSHConfig(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(er)
	if strings.Contains(string(b), "null") {
		t.Fatalf("export report contains null: %s", b)
	}
	// list endpoints too
	for name, v := range map[string]any{"groups": h.app.Host.ListGroups(), "hosts": h.app.Host.ListHosts(domain.HostFilter{Query: "nomatch"}),
		"identities": h.app.Vault.ListIdentities(), "forwards": h.app.Forward.List()} {
		b, _ := json.Marshal(v)
		if string(b) == "null" {
			t.Errorf("%s marshals to null", name)
		}
	}
}
