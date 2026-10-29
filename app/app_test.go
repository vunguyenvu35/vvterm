package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vvterm/internal/vault"
)

func TestDataDirEnvOverride(t *testing.T) {
	t.Setenv("VVTERM_DATA_DIR", "/tmp/xyz")
	if d, _ := DataDir(); d != "/tmp/xyz" {
		t.Fatal(d)
	}
	t.Setenv("VVTERM_DATA_DIR", "")
	d, err := DataDir()
	if err != nil || !strings.HasSuffix(d, "vvterm") {
		t.Fatalf("%q %v", d, err)
	}
}

// The composition root must produce a working app on real adapters.
func TestBuildWiresRealAdapters(t *testing.T) {
	a, err := Build(t.TempDir(), vault.NewMemKeychain(), &vault.KDFParams{Memory: 64, Time: 1, Threads: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Vault.Create("a long master password"); err != nil {
		t.Fatal(err)
	}
	id, err := a.Vault.AddPassword("x", "u", "p")
	if err != nil || id.ID == "" {
		t.Fatalf("%v %+v", err, id)
	}
	if a.System.Info().Version == "" {
		t.Fatal("version empty")
	}
	if _, err := a.System.PickFile("x"); err == nil {
		t.Fatal("dialogs must be unavailable before Startup")
	}
}

func TestOpenURLOnlyAllowsProjectLinks(t *testing.T) {
	for _, ok := range []string{
		"https://github.com/vunguyenvu35/vvterm",
		"https://github.com/vunguyenvu35/vvterm/issues/new",
		"https://ko-fi.com/vunguyenvu",
	} {
		if !urlAllowed(ok) {
			t.Errorf("%s should be allowed", ok)
		}
	}
	for _, bad := range []string{
		"", "http://github.com/vunguyenvu35/vvterm", "https://github.com/vunguyenvu35/vvterm-evil",
		"https://github.com/vunguyenvu35/vvtermx/issues", "https://evil.example/https://ko-fi.com/vunguyenvu",
		"javascript:alert(1)", "file:///etc/passwd", "https://ko-fi.com/vunguyenvu.evil.com",
	} {
		if urlAllowed(bad) {
			t.Errorf("%q must be rejected", bad)
		}
	}
	a, err := Build(t.TempDir(), vault.NewMemKeychain(), &vault.KDFParams{Memory: 64, Time: 1, Threads: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.System.OpenURL("https://evil.example"); err == nil {
		t.Fatal("foreign link opened")
	}
}

func TestNativeDialogsCanBeDisabledByEnvironment(t *testing.T) {
	s := NewSystemService()
	s.SetContext(context.Background())
	t.Setenv("VVTERM_NO_NATIVE_DIALOGS", "1")
	if _, err := s.PickFile("x"); err == nil {
		t.Fatal("PickFile must fail so the UI falls back to a prompt")
	}
	if _, err := s.SaveFile("x", "a.txt"); err == nil {
		t.Fatal("SaveFile must fail so the UI falls back to a prompt")
	}
	if _, err := s.PickDirectory("x"); err == nil {
		t.Fatal("PickDirectory must fail so the UI falls back to a prompt")
	}
}

func TestClipboardNeedsANativeWindow(t *testing.T) {
	s := NewSystemService()
	if _, err := s.ClipboardText(); err == nil {
		t.Fatal("no window: the frontend must fall back to the browser clipboard")
	}
	if err := s.SetClipboardText("x"); err == nil {
		t.Fatal("no window")
	}
	s.SetContext(context.Background())
	t.Setenv("VVTERM_NO_NATIVE_DIALOGS", "1")
	if _, err := s.ClipboardText(); err == nil {
		t.Fatal("the e2e switch keeps the browser clipboard")
	}
	if err := s.SetClipboardText(strings.Repeat("x", maxClipboard+1)); err == nil {
		t.Fatal("too much text")
	}
}

func TestOpenPathRefusesFilesThatRunPrograms(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"x.command", "x.SH", "x.app", "x.exe", "x.pkg"} {
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, []byte("x"), 0o644)
		if _, err := openCommand(p, ""); err == nil {
			t.Errorf("%s must not be opened", name)
		}
	}
	ok := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(ok, []byte("x"), 0o644)
	if cmd, err := openCommand(ok, ""); err != nil || cmd == nil {
		t.Fatalf("%v", err)
	}
	if _, err := openCommand(filepath.Join(dir, "missing.txt"), ""); err == nil {
		t.Fatal("a file that is not there")
	}
	s := NewSystemService()
	if err := s.OpenPath(ok); err == nil {
		t.Fatal("no native window: nothing is opened")
	}
	s.SetContext(context.Background())
	if err := s.OpenPath("relative.txt"); err == nil {
		t.Fatal("relative path")
	}
}

func TestSettingsExecutableUsesTheDocklessHelperWhenBuilt(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // the cache helper of a stale one is made here, not in the real cache
	root := t.TempDir()
	exe := filepath.Join(root, "vvterm.app", "Contents", "MacOS", "vvterm")
	if got := settingsExecutable(exe); got != exe {
		t.Fatalf("no helper: got %q, want the app itself", got)
	}
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, []byte("build 2"), 0o755); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(root, "vvterm.app", "Contents", "Helpers", "VVTerm Settings.app", "Contents", "MacOS", "vvterm-settings")
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		t.Fatal(err)
	}
	// a helper left by an older build is not the running program: it must not be used (it would show the old version)
	if err := os.WriteFile(helper, []byte("build 1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, _ := filepath.Abs(settingsExecutable(exe)); got == helper {
		t.Fatalf("a stale helper was used: %q", got)
	}
	// the helper of this build (a hard link, or a copy with the same bytes) is used
	if err := os.Remove(helper); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(exe, helper); err != nil {
		t.Fatal(err)
	}
	if got, _ := filepath.Abs(settingsExecutable(exe)); got != helper {
		t.Fatalf("got %q, want the helper %q", got, helper)
	}
	if err := os.Remove(helper); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("build 2"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, _ := filepath.Abs(settingsExecutable(exe)); got != helper {
		t.Fatalf("a copy with the same bytes: got %q, want %q", got, helper)
	}
}

func TestSameProgram(t *testing.T) {
	d := t.TempDir()
	w := func(name, body string) string {
		p := filepath.Join(d, name)
		if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	a, b, c := w("a", strings.Repeat("x", 3<<20)), w("b", strings.Repeat("x", 3<<20)), w("c", strings.Repeat("x", 3<<20-1)+"y")
	if !sameProgram(a, b) || sameProgram(a, c) || sameProgram(a, filepath.Join(d, "missing")) {
		t.Fatal("same bytes are the same program; one different byte, or a missing file, is not")
	}
}

func TestPrepareSettingsHelperLinksThePlistAndRefreshesOnRebuild(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "vvterm")
	if err := os.WriteFile(exe, []byte("v1"), 0o755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "cache")
	bin, err := prepareSettingsHelper(exe, root)
	if err != nil {
		t.Fatal(err)
	}
	plist, err := os.ReadFile(filepath.Join(root, "VVTerm Settings.app", "Contents", "Info.plist"))
	if err != nil || !strings.Contains(string(plist), "<key>LSUIElement</key><true/>") {
		t.Fatalf("the helper must have no Dock icon: %v %q", err, plist)
	}
	if b, _ := os.ReadFile(bin); string(b) != "v1" {
		t.Fatalf("helper runs %q", b)
	}
	// a rebuilt app replaces the file: the helper follows
	if err := os.Remove(exe); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, []byte("v22"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin2, err := prepareSettingsHelper(exe, root)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(bin2); string(b) != "v22" {
		t.Fatalf("helper not refreshed: %q", b)
	}
}
