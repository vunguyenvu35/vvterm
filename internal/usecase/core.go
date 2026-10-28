// Package usecase holds the application logic. It depends on the domain and on the ports declared
// in ports.go, never on Wails or on concrete storage.

package usecase

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
	"vvterm/internal/fsutil"

	"vvterm/internal/sshx"
)

// Settings is persisted in settings.json and never synced.
type Settings struct {
	Theme           string `json:"theme"`
	FontSize        int    `json:"font_size"`
	FontFamily      string `json:"font_family"`
	AutoLockMinutes int    `json:"auto_lock_minutes"`
	SyncURL         string `json:"sync_url"`
}

func defaultSettings() Settings {
	return Settings{Theme: "dark", FontSize: 13, FontFamily: "Menlo, Monaco, 'Courier New', monospace", AutoLockMinutes: 15}
}

// Core wires the packages together; the services below share one instance.
type Core struct {
	Dir      string // root of user data (contains data/ and sync/)
	DataDir  string
	SyncDir  string
	Store    Repository
	Vault    SecretVault
	Dialer   *sshx.Dialer
	emit     Emitter
	setMu    sync.Mutex
	settings Settings

	prompts *prompter
}

// Options carries the adapters and settings NewCore needs. The composition root builds the
// concrete Repository and SecretVault (see app.NewCore); tests inject their own.
type Options struct {
	Store Repository
	Vault SecretVault
	Emit  Emitter
}

// NewCore wires the use cases around the given ports. dir is the root of user data.
func NewCore(dir string, opt Options) (*Core, error) {
	if opt.Store == nil || opt.Vault == nil {
		return nil, errors.New("store and vault ports are required")
	}
	c := &Core{Dir: dir, DataDir: filepath.Join(dir, "data"), SyncDir: filepath.Join(dir, "sync"), emit: opt.Emit,
		Store: opt.Store, Vault: opt.Vault, prompts: newPrompter()}
	if c.emit == nil {
		c.emit = func(string, ...any) {}
	}
	if err := os.MkdirAll(c.DataDir, 0o700); err != nil {
		return nil, err
	}
	c.settings = defaultSettings()
	if b, err := os.ReadFile(filepath.Join(c.DataDir, "settings.json")); err == nil {
		_ = json.Unmarshal(b, &c.settings)
	}
	c.Vault.SetAutoLock(time.Duration(c.settings.AutoLockMinutes) * time.Minute)
	c.Vault.OnLock(func() { c.emit("vault:locked") })
	c.Dialer = &sshx.Dialer{
		HostKeys: &sshx.HostKeyChecker{Path: filepath.Join(c.DataDir, "known_hosts")},
		Timeout:  15 * time.Second,
	}
	return c, nil
}

// SetEmitter replaces the event sink once the delivery layer is ready (Wails OnStartup).
func (c *Core) SetEmitter(e Emitter) { c.emit = e }

func (c *Core) saveSettings() error {
	b, err := json.MarshalIndent(c.settings, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(filepath.Join(c.DataDir, "settings.json"), b, 0o600)
}

var errNotUnlocked = errors.New("vault is locked: unlock it first")

// prompter pairs a pending host-key question with its answer.
type prompter struct {
	mu      sync.Mutex
	pending map[string]chan bool
	fp      map[string]string
	pay     map[string]any
}

func newPrompter() *prompter {
	return &prompter{pending: map[string]chan bool{}, fp: map[string]string{}, pay: map[string]any{}}
}

// ask registers a question under key and returns the channel the answer arrives on.
func (p *prompter) ask(key, fingerprint string, payload any) chan bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	ch := make(chan bool, 1)
	p.pending[key] = ch
	p.fp[key] = fingerprint
	p.pay[key] = payload
	return ch
}

// payload returns the pending prompt's event payload, for replay on Attach.
func (p *prompter) payload(key string) (any, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	v, ok := p.pay[key]
	return v, ok
}

func (p *prompter) clear(key string) {
	p.mu.Lock()
	delete(p.pending, key)
	delete(p.fp, key)
	delete(p.pay, key)
	p.mu.Unlock()
}

// answer delivers the user's decision. The fingerprint must match the one that was shown,
// so a stale or forged answer cannot trust a different key.
func (p *prompter) answer(key, fingerprint string, trust bool) error {
	p.mu.Lock()
	ch, ok := p.pending[key]
	want := p.fp[key]
	p.mu.Unlock()
	if !ok {
		return errors.New("no host key confirmation is pending")
	}
	if trust && fingerprint != want {
		return errors.New("fingerprint does not match the one that was displayed")
	}
	select {
	case ch <- trust:
	default:
	}
	return nil
}
