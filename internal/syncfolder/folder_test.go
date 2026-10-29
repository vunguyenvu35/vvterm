package syncfolder

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/syncgit"
	"vvterm/internal/vault"
)

var t0 = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func host(id, label string, at time.Duration) domain.Host {
	return domain.Host{Meta: domain.Meta{ID: id, UpdatedAt: t0.Add(at)}, Label: label, Hostname: label, Port: 22}
}

func bundleOf(hs ...domain.Host) syncgit.Bundle { return syncgit.Bundle{Data: domain.Data{Hosts: hs}} }

func labels(b syncgit.Bundle) map[string]bool {
	m := map[string]bool{}
	for _, h := range b.Data.Hosts {
		if !h.Deleted() {
			m[h.Label] = true
		}
	}
	return m
}

func machine(t *testing.T, from *vault.Vault) *vault.Vault {
	t.Helper()
	v, err := vault.New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	v.SetKDF(vault.KDFParams{Memory: 64, Time: 1, Threads: 1})
	if from == nil {
		err = v.Create("a long master password")
	} else {
		h, _ := from.Header()
		err = v.Adopt("a long master password", h, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func sync(t *testing.T, f *Folder, v *vault.Vault, b syncgit.Bundle) syncgit.Result {
	t.Helper()
	h, _ := v.Header()
	res, err := f.Sync(b, h, v)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	return res
}

func TestTwoMachinesConvergeAndSecondSyncIsNoop(t *testing.T) {
	dir := t.TempDir()
	f := &Folder{Dir: dir}
	a := machine(t, nil)
	b := machine(t, a)
	sync(t, f, a, bundleOf(host("h1", "from-a", 0)))
	res := sync(t, f, b, bundleOf(host("h2", "from-b", 0)))
	if l := labels(res.Merged); !l["from-a"] || !l["from-b"] {
		t.Fatalf("%v", l)
	}
	if again := sync(t, f, b, res.Merged); again.Pushed {
		t.Fatal("an unchanged sync must not rewrite the files")
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 2 {
		t.Fatalf("only bundle.enc and vault-header.json may exist, got %d entries", len(ents))
	}
}

func TestConflictCopiesAreMergedAndRemoved(t *testing.T) {
	dir := t.TempDir()
	f := &Folder{Dir: dir}
	a := machine(t, nil)
	b := machine(t, a)
	sync(t, f, a, bundleOf(host("h1", "from-a", 0)))
	// B wrote at the same time; the cloud client kept its file as a copy.
	other := t.TempDir()
	sync(t, &Folder{Dir: other}, b, bundleOf(host("h2", "from-b", 0)))
	blob, _ := os.ReadFile(filepath.Join(other, syncgit.BundleFile))
	copyPath := filepath.Join(dir, "bundle (1).enc")
	if err := os.WriteFile(copyPath, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	res := sync(t, f, a, bundleOf(host("h1", "from-a", 0)))
	if l := labels(res.Merged); !l["from-a"] || !l["from-b"] {
		t.Fatalf("copy not merged: %v", l)
	}
	if _, err := os.Stat(copyPath); !os.IsNotExist(err) {
		t.Fatal("the merged copy must be removed")
	}
}

func TestForeignOrUnreadableCopyIsKept(t *testing.T) {
	dir := t.TempDir()
	f := &Folder{Dir: dir}
	a := machine(t, nil)
	sync(t, f, a, bundleOf(host("h1", "x", 0)))
	junk := filepath.Join(dir, "bundle (2).enc")
	os.WriteFile(junk, []byte("half downloaded"), 0o600)
	sync(t, f, a, bundleOf(host("h1", "x", 0)))
	if _, err := os.Stat(junk); err != nil {
		t.Fatal("an unreadable copy must be left alone")
	}
}

func TestOtherVaultIsRefused(t *testing.T) {
	dir := t.TempDir()
	f := &Folder{Dir: dir}
	sync(t, f, machine(t, nil), bundleOf(host("h1", "x", 0)))
	other := machine(t, nil)
	h, _ := other.Header()
	if _, err := f.Sync(bundleOf(), h, other); err != syncgit.ErrVaultMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestCheckRejectsBadFolders(t *testing.T) {
	for _, d := range []string{"relative/path", filepath.Join(t.TempDir(), "missing")} {
		if (&Folder{Dir: d}).Check() == nil {
			t.Fatalf("%q must be refused", d)
		}
	}
}
