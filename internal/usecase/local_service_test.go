package usecase

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func localFixture(t *testing.T) (*LocalService, string) {
	t.Helper()
	dir := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.Mkdir(filepath.Join(dir, "Zeta"), 0o755))
	must(os.Mkdir(filepath.Join(dir, "alpha"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "b.txt"), []byte("12345"), 0o644))
	must(os.WriteFile(filepath.Join(dir, ".hidden"), nil, 0o600))
	must(os.Symlink(filepath.Join(dir, "alpha"), filepath.Join(dir, "link-to-alpha")))
	return NewLocalService(), dir
}

func TestLocalListSortsFoldersFirstAndIncludesHiddenAndLinks(t *testing.T) {
	s, dir := localFixture(t)
	got, err := s.List(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range got {
		names = append(names, e.Name)
	}
	want := "alpha,link-to-alpha,Zeta,.hidden,b.txt"
	if strings.Join(names, ",") != want {
		t.Fatalf("got %v, want %s", names, want)
	}
	for _, e := range got {
		if e.Name == "link-to-alpha" && (!e.IsLink || !e.IsDir) {
			t.Fatalf("a link to a folder is a folder link: %+v", e)
		}
		if e.Name == "b.txt" && (e.Size != 5 || e.IsDir || e.Path != filepath.Join(dir, "b.txt")) {
			t.Fatalf("%+v", e)
		}
	}
}

func TestLocalRejectsRelativeEmptyAndNulPaths(t *testing.T) {
	s := NewLocalService()
	for _, p := range []string{"", "relative/dir", "../x", "/tmp/a\x00b"} {
		if _, err := s.List(p); err == nil {
			t.Errorf("List(%q) must fail", p)
		}
		if err := s.Mkdir(p); err == nil {
			t.Errorf("Mkdir(%q) must fail", p)
		}
		if err := s.Delete(p, true); err == nil {
			t.Errorf("Delete(%q) must fail", p)
		}
	}
}

func TestLocalMkdirRenameDeleteNeverOverwrite(t *testing.T) {
	s, dir := localFixture(t)
	if err := s.Mkdir(filepath.Join(dir, "new")); err != nil {
		t.Fatal(err)
	}
	if err := s.Mkdir(filepath.Join(dir, "new")); err == nil {
		t.Fatal("mkdir must not succeed on an existing folder")
	}
	if err := s.Rename(filepath.Join(dir, "b.txt"), filepath.Join(dir, "new")); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("rename onto an existing name must be refused: %v", err)
	}
	if err := s.Rename(filepath.Join(dir, "b.txt"), filepath.Join(dir, "c.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "c.txt")); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(filepath.Join(dir, "alpha"), false); err != nil { // empty folder
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "Zeta", "f"), nil, 0o644)
	if err := s.Delete(filepath.Join(dir, "Zeta"), false); err == nil {
		t.Fatal("a non-empty folder needs recursive")
	}
	if err := s.Delete(filepath.Join(dir, "Zeta"), true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "Zeta")); !os.IsNotExist(err) {
		t.Fatal("Zeta must be gone")
	}
}

func TestLocalProtectsRootAndHome(t *testing.T) {
	s := NewLocalService()
	home, _ := s.Home()
	for _, p := range []string{"/", home} {
		if err := s.Delete(p, true); err == nil {
			t.Errorf("Delete(%q) must be refused", p)
		}
		if err := s.Rename(p, filepath.Join(os.TempDir(), "moved-away")); err == nil {
			t.Errorf("Rename(%q) must be refused", p)
		}
	}
	if !filepath.IsAbs(home) {
		t.Fatalf("home %q", home)
	}
}

func TestLocalChmodChangesTheBitsAndRefusesNonsense(t *testing.T) {
	s, dir := localFixture(t)
	f := filepath.Join(dir, "b.txt")
	if err := s.Chmod(f, 0o600); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(f); info.Mode().Perm() != 0o600 {
		t.Fatalf("%v", info.Mode())
	}
	for _, bad := range []int{-1, 0o10000} {
		if err := s.Chmod(f, bad); err == nil {
			t.Fatalf("%o accepted", bad)
		}
	}
	if err := s.Chmod("relative", 0o644); err == nil {
		t.Fatal("relative path")
	}
	if err := s.Chmod("/", 0o777); err == nil {
		t.Fatal("the root is protected")
	}
	d, err := s.TempDir()
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(d)
	if info, err := os.Stat(d); err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("%v %v", info, err)
	}
}
