package usecase

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResetSettingsKeepsAccountAndSyncTarget(t *testing.T) {
	h := newHarness(t).unlocked(t)
	s := h.app.Settings.Get()
	s.Zoom, s.FontSize, s.Theme = 140, 20, "light"
	s.AccountName, s.AccountEmail = "Vu", "vu@example.com"
	s.Shortcuts = map[string]string{"new_connection": "Mod+T"}
	if _, err := h.app.Settings.Save(s); err != nil {
		t.Fatal(err)
	}
	if err := h.app.Vault.SetAutoLock(5); err != nil {
		t.Fatal(err)
	}
	h.core.settings.SyncURL = "git@example.com:me/sync.git"

	got, err := h.app.Settings.ResetSettings()
	if err != nil {
		t.Fatal(err)
	}
	def := defaultSettings()
	if got.Zoom != def.Zoom || got.FontSize != def.FontSize || got.Theme != def.Theme || got.AutoLockMinutes != def.AutoLockMinutes || len(got.Shortcuts) != 0 {
		t.Fatalf("preferences must be the defaults: %+v", got)
	}
	if got.AccountName != "Vu" || got.AccountEmail != "vu@example.com" || got.SyncURL != "git@example.com:me/sync.git" {
		t.Fatalf("the account and the sync target are kept: %+v", got)
	}
	if b, err := os.ReadFile(filepath.Join(h.core.DataDir, "settings.json")); err != nil || len(b) == 0 {
		t.Fatalf("the reset is saved: %v", err)
	}
	if again := h.app.Settings.Get(); again.Zoom != def.Zoom {
		t.Fatalf("Get after reset: %+v", again)
	}
}

func TestClearCacheRemovesCacheFilesAndForgetsTheAITools(t *testing.T) {
	h := newHarness(t).unlocked(t)
	cache := filepath.Join(t.TempDir(), "vvterm")
	if err := os.MkdirAll(filepath.Join(cache, "helper"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "helper", "a"), make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "b"), make([]byte, 20), 0o600); err != nil {
		t.Fatal(err)
	}
	h.core.CacheDir = cache
	data := filepath.Join(h.core.DataDir, "settings.json")
	_ = os.WriteFile(data, []byte("{}"), 0o600)
	h.app.Assistant.detected = true

	r, err := h.app.Settings.ClearCache()
	if err != nil {
		t.Fatal(err)
	}
	if r.Files != 2 || r.Bytes != 120 {
		t.Fatalf("report: %+v", r)
	}
	if left, _ := os.ReadDir(cache); len(left) != 0 {
		t.Fatalf("the cache folder must be empty: %v", left)
	}
	if _, err := os.Stat(data); err != nil {
		t.Fatalf("user data must stay: %v", err)
	}
	if _, err := os.Stat(cache); err != nil {
		t.Fatalf("the folder itself stays: %v", err)
	}
}

func TestClearCacheWithoutAFolderIsFine(t *testing.T) {
	h := newHarness(t).unlocked(t)
	if r, err := h.app.Settings.ClearCache(); err != nil || r.Files != 0 {
		t.Fatalf("%+v %v", r, err)
	}
	h.core.CacheDir = filepath.Join(t.TempDir(), "missing")
	if r, err := h.app.Settings.ClearCache(); err != nil || r.Files != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}
