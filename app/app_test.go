package app

import (
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
