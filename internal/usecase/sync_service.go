package usecase

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/syncfolder"
	"vvterm/internal/syncgit"
	"vvterm/internal/vault"
)

// SyncStatus is the frontend view of the sync state.
type SyncStatus struct {
	Configured bool      `json:"configured"`
	RepoURL    string    `json:"repo_url"`
	Folder     string    `json:"folder"` // set in synced-folder mode; RepoURL is empty then
	LastSync   time.Time `json:"last_sync"`
	LastError  string    `json:"last_error,omitempty"`
	Syncing    bool      `json:"syncing"`
}

// SyncService syncs the encrypted bundle through a Git repo the user owns, or through a folder
// that a cloud client (Google Drive, iCloud Drive, Dropbox...) keeps in step.
type SyncService struct {
	c *Core

	mu     sync.Mutex
	status SyncStatus
}

func NewSyncService(c *Core) *SyncService {
	s := &SyncService{c: c}
	s.status.RepoURL = c.settings.SyncURL
	s.status.Folder = c.settings.SyncFolder
	s.status.Configured = c.settings.SyncURL != "" || c.settings.SyncFolder != ""
	return s
}

func (s *SyncService) repo() *syncgit.Repo {
	return &syncgit.Repo{Dir: s.c.SyncDir, URL: s.status.RepoURL}
}

// Configure stores the repo URL and prepares the local working copy. Authentication relies on
// the user's ssh-agent or git credential helper.
func (s *SyncService) Configure(repoURL string) error {
	repoURL = strings.TrimSpace(repoURL)
	r := &syncgit.Repo{Dir: s.c.SyncDir, URL: repoURL}
	if err := r.Init(); err != nil {
		return err
	}
	s.c.setMu.Lock()
	s.c.settings.SyncURL, s.c.settings.SyncFolder = repoURL, ""
	err := s.c.saveSettings()
	s.c.setMu.Unlock()
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.status.RepoURL, s.status.Folder, s.status.Configured, s.status.LastError = repoURL, "", true, ""
	s.mu.Unlock()
	return nil
}

// ConfigureFolder syncs through a folder instead of Git. Only bundle.enc and vault-header.json
// are written there, both encrypted.
func (s *SyncService) ConfigureFolder(dir string) error {
	dir = filepath.Clean(strings.TrimSpace(dir))
	if err := (&syncfolder.Folder{Dir: dir}).Check(); err != nil {
		return err
	}
	s.c.setMu.Lock()
	s.c.settings.SyncFolder, s.c.settings.SyncURL = dir, ""
	err := s.c.saveSettings()
	s.c.setMu.Unlock()
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.status.Folder, s.status.RepoURL, s.status.Configured, s.status.LastError = dir, "", true, ""
	s.mu.Unlock()
	return nil
}

func (s *SyncService) folder() (*syncfolder.Folder, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status.Folder == "" {
		return nil, false
	}
	return &syncfolder.Folder{Dir: s.status.Folder}, true
}

func (s *SyncService) Status() SyncStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *SyncService) begin() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.status.Configured {
		return errors.New("sync is not configured: choose a Git repository or a folder first")
	}
	if s.status.Syncing {
		return errors.New("a sync is already running")
	}
	s.status.Syncing = true
	return nil
}

func (s *SyncService) end(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.Syncing = false
	if err != nil {
		s.status.LastError = err.Error()
		s.c.record(domain.ActSync, "", "", "Sync failed: "+err.Error(), false)
		return
	}
	s.c.record(domain.ActSync, "", "", "Synced", true)
	s.status.LastError = ""
	s.status.LastSync = time.Now().UTC()
}

// SyncNow fetches, merges per record, re-encrypts and pushes. The vault must be unlocked.
func (s *SyncService) SyncNow() (err error) {
	if err = s.begin(); err != nil {
		return err
	}
	defer func() { s.end(err) }()
	if !s.c.Vault.Status().Unlocked {
		return errNotUnlocked
	}
	hdr, err := s.c.Vault.Header()
	if err != nil {
		return err
	}
	local := syncgit.Bundle{Data: s.c.Store.Snapshot(), Secrets: s.c.Vault.Secrets()}
	var res syncgit.Result
	if f, ok := s.folder(); ok {
		res, err = f.Sync(local, hdr, s.c.Vault)
	} else {
		r := s.repo()
		if err = r.Init(); err != nil {
			return err
		}
		res, err = r.Sync(local, hdr, s.c.Vault)
	}
	if err != nil {
		return err
	}
	if err = s.c.Store.Replace(res.Merged.Data); err != nil {
		return err
	}
	return s.c.Vault.ReplaceSecrets(res.Merged.Secrets)
}

// JoinExisting sets up a new machine from a repo that already holds a bundle: the master
// password unwraps the DEK from vault-header.json and all data is restored.
func (s *SyncService) JoinExisting(masterPassword string) (err error) {
	if err = s.begin(); err != nil {
		return err
	}
	defer func() { s.end(err) }()
	if s.c.Vault.Status().Exists {
		return errors.New("this machine already has a vault; use Sync now instead")
	}
	var (
		hdr    vault.Header
		enc    []byte
		exists bool
	)
	if f, ok := s.folder(); ok {
		if err = f.Check(); err != nil {
			return err
		}
		hdr, enc, exists, err = f.Remote()
	} else {
		r := s.repo()
		if err = r.Init(); err != nil {
			return err
		}
		if err = r.Fetch(); err != nil {
			return err
		}
		hdr, enc, exists, err = r.Remote()
	}
	if err != nil {
		return err
	}
	if !exists {
		return errors.New("nothing to restore: no VVTerm bundle was found there yet")
	}
	if err = s.c.Vault.Adopt(masterPassword, hdr, nil); err != nil {
		return err
	}
	plain, err := s.c.Vault.OpenBlob(enc, []byte(syncgit.BundleAAD))
	if err != nil {
		return fmt.Errorf("bundle cannot be decrypted: %w", err)
	}
	var b syncgit.Bundle
	if err = json.Unmarshal(plain, &b); err != nil {
		return err
	}
	if err = s.c.Store.Replace(b.Data); err != nil {
		return err
	}
	return s.c.Vault.ReplaceSecrets(b.Secrets)
}
