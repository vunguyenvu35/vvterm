// Package usecase holds the application logic. It depends on the domain and on the ports declared
// in ports.go, never on Wails or on concrete storage.

package usecase

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"vvterm/internal/domain"
	"vvterm/internal/fsutil"

	"vvterm/internal/sshx"
)

// Settings is persisted in settings.json and never synced.
type Settings struct {
	Theme         string `json:"theme"`          // app appearance: auto | light | dark
	TerminalTheme string `json:"terminal_theme"` // "auto" (follow the app) or a theme id from the UI catalogue
	FontSize      int    `json:"font_size"`
	FontFamily    string `json:"font_family"`
	CursorStyle   string `json:"cursor_style"` // block | bar | underline
	CursorBlink   bool   `json:"cursor_blink"`
	// CopyOnSelect copies the selection to the clipboard as soon as it is made, like Termius.
	CopyOnSelect bool `json:"copy_on_select"`
	// RightClick is what a right click in a terminal does: paste | menu | none.
	RightClick      string `json:"right_click"`
	Scrollback      int    `json:"scrollback"`
	AutoLockMinutes int    `json:"auto_lock_minutes"`
	SyncURL         string `json:"sync_url"`

	// General
	Zoom            int  `json:"zoom"`              // interface scale in percent (80..160)
	AskProtocol     bool `json:"ask_protocol"`      // a host opens on a "Choose protocol" screen first (off by default)
	ConfirmTabClose bool `json:"confirm_tab_close"` // ask before closing a terminal tab or pane (off by default)
	Highlight       bool `json:"highlight"`         // colour URLs, IPs, paths and error/warning/success words in terminal output
	ReduceMotion    bool `json:"reduce_motion"`     // turn animations off

	// Account: a local profile today, the hook for sign-in and team features later
	AccountName  string `json:"account_name"`
	AccountEmail string `json:"account_email"`

	// Shortcuts holds only the user's overrides (action id -> combo such as "Mod+Shift+K"); an action
	// without an entry uses its default, which lives with the UI that implements it.
	Shortcuts map[string]string `json:"shortcuts"`
}

func defaultSettings() Settings {
	return Settings{Theme: "dark", TerminalTheme: "auto", FontSize: 13, FontFamily: "Menlo, Monaco, 'Courier New', monospace",
		CursorStyle: "block", CursorBlink: true, CopyOnSelect: true, RightClick: "paste", Scrollback: 10000, AutoLockMinutes: 15,
		Zoom: 100, Highlight: true, Shortcuts: map[string]string{}}
}

// Core wires the packages together; the services below share one instance.
type Core struct {
	Dir     string // root of user data (contains data/ and sync/)
	DataDir string
	SyncDir string
	Store   Repository
	Vault   SecretVault
	Dialer  *sshx.Dialer
	// OpenRemoteFS starts SFTP on an SSH connection; nil disables the SFTP feature.
	OpenRemoteFS RemoteFSOpener
	// OpenLocalShell, OpenSerial and ListSerial back the Terminal and Serial features; nil disables them.
	OpenLocalShell ShellOpener
	OpenSerial     SerialOpener
	OpenTelnet     TelnetOpener
	ListSerial     SerialLister
	// Activity is the log shown on the Logs page; nil keeps no history.
	Activity ActivityLog
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
	// OpenRemoteFS is the SFTP adapter (optional).
	OpenRemoteFS RemoteFSOpener
	// Local terminal and serial adapters (optional).
	OpenLocalShell ShellOpener
	OpenSerial     SerialOpener
	OpenTelnet     TelnetOpener
	ListSerial     SerialLister
	// Activity stores the activity log (optional).
	Activity ActivityLog
}

// NewCore wires the use cases around the given ports. dir is the root of user data.
func NewCore(dir string, opt Options) (*Core, error) {
	if opt.Store == nil || opt.Vault == nil {
		return nil, errors.New("store and vault ports are required")
	}
	c := &Core{Dir: dir, DataDir: filepath.Join(dir, "data"), SyncDir: filepath.Join(dir, "sync"), emit: opt.Emit,
		Store: opt.Store, Vault: opt.Vault, prompts: newPrompter(), OpenRemoteFS: opt.OpenRemoteFS,
		OpenLocalShell: opt.OpenLocalShell, OpenSerial: opt.OpenSerial, OpenTelnet: opt.OpenTelnet, ListSerial: opt.ListSerial, Activity: opt.Activity}
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

// learnOS works out the server type on the first connection to a host and stores it, so the UI can show
// the right icon. It runs in the background, asks for nothing the user typed, and gives up quietly when
// the server refuses commands (the SSH version string alone may still tell). It never runs again once
// the type is known.
func (c *Core) learnOS(host domain.Host, cl *sshx.Client) {
	if host.OS != "" {
		return
	}
	go func() {
		version := string(cl.Client.ServerVersion())
		out, _ := cl.Exec("uname -s; echo ---VVTERM---; cat /etc/os-release 2>/dev/null", 5*time.Second) // a non-zero exit still carries the output
		uname, release, _ := strings.Cut(out, "---VVTERM---")
		name := domain.ParseOS(version, uname, release)
		if name == "" {
			return
		}
		if err := c.Store.SetHostOS(host.ID, name); err == nil {
			c.emit("hosts:changed", host.ID)
		}
	}()
}
