package app

import (
	"context"
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
