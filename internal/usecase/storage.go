package usecase

import (
	"os"
	"path/filepath"
	"time"

	"vvterm/internal/domain/assistant"
)

// CacheReport says what Clear cache removed.
type CacheReport struct {
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
}

// ResetSettings puts every preference back to its default: appearance, terminal, general options, shortcuts and
// the auto-lock time. What connects the app to something is kept: the account profile and the sync target. Hosts,
// keys, the vault, the AI assistant's configuration and known hosts are not touched.
func (s *SettingsService) ResetSettings() (Settings, error) {
	s.c.setMu.Lock()
	keep := s.c.settings
	s.c.settings = defaultSettings()
	s.c.settings.AccountName, s.c.settings.AccountEmail = keep.AccountName, keep.AccountEmail
	s.c.settings.SyncURL, s.c.settings.SyncFolder = keep.SyncURL, keep.SyncFolder
	out := s.c.settings
	err := s.c.saveSettings()
	s.c.setMu.Unlock()
	s.c.Vault.SetAutoLock(time.Duration(out.AutoLockMinutes) * time.Minute)
	return out, err
}

// ClearCache removes what the app can make again: the files in its cache folder and what it remembers about the
// AI tools (their state and model lists, looked up again on the next visit). Nothing the user created is touched.
func (s *SettingsService) ClearCache() (CacheReport, error) {
	var r CacheReport
	if s.OnClearCache != nil {
		s.OnClearCache()
	}
	dir := s.c.CacheDir
	if dir == "" {
		return r, nil
	}
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	var firstErr error
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		files, bytes := sizeOf(p)
		if err := os.RemoveAll(p); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		r.Files += files
		r.Bytes += bytes
	}
	return r, firstErr
}

// sizeOf counts the files under p (p itself when it is a file) and their size.
func sizeOf(p string) (files int, bytes int64) {
	_ = filepath.WalkDir(p, func(_ string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			files++
			bytes += info.Size()
		}
		return nil
	})
	return files, bytes
}

// ClearCache forgets what was found out about the AI tools; the next visit looks again.
func (a *AssistantService) ClearCache() {
	a.mu.Lock()
	a.status = map[string]assistant.Status{}
	a.models = map[string]modelCache{}
	a.detected = false
	a.mu.Unlock()
	a.Warm()
}
