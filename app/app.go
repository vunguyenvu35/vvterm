// Package app is the delivery layer: it adapts the use cases to Wails bindings and events and
// is the composition root that builds the concrete adapters (storage, vault, keychain).
package app

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"vvterm/internal/localtty"
	"vvterm/internal/serialx"
	"vvterm/internal/sftpx"
	"vvterm/internal/sqlitedb"
	"vvterm/internal/sshx"
	"vvterm/internal/store"
	"vvterm/internal/telnetx"
	"vvterm/internal/usecase"
	"vvterm/internal/vault"
)

// Version is injected at build time with -ldflags "-X vvterm/app.Version=...".
var Version = "dev"

// App bundles the use cases (bound to the frontend) and the Wails-only system service.
type App struct {
	*usecase.Services
	System *SystemService
	db     *sqlitedb.DB
	dir    string

	bridge   *Bridge
	launcher *SettingsLauncher
	ctx      context.Context
}

// DataDir resolves where user data lives: $VVTERM_DATA_DIR, else the OS config dir
// (macOS: ~/Library/Application Support/vvterm).
func DataDir() (string, error) {
	if d := os.Getenv("VVTERM_DATA_DIR"); d != "" {
		return d, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "vvterm"), nil
}

// Build is the composition root: it creates the concrete adapters and wires the use cases.
func Build(dir string, kc vault.Keychain, kdf *vault.KDFParams) (*App, error) {
	data := filepath.Join(dir, "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		return nil, err
	}
	db, err := sqlitedb.Open(filepath.Join(data, "vvterm.db"))
	if err != nil {
		return nil, err
	}
	st, err := store.OpenWith(db.StorePersister())
	if err != nil {
		db.Close()
		return nil, err
	}
	if kc == nil {
		kc = vault.OSKeychain{}
	}
	v, err := vault.NewWith(db.VaultPersister(), data, kc)
	if err != nil {
		db.Close()
		return nil, err
	}
	if kdf != nil {
		v.SetKDF(*kdf)
	}
	core, err := usecase.NewCore(dir, usecase.Options{Store: st, Vault: v, OpenRemoteFS: func(c *sshx.Client) (usecase.RemoteFS, error) { return sftpx.Open(c.Client) },
		OpenLocalShell: func(cols, rows int, onData func([]byte)) (usecase.Shell, error) {
			return localtty.Open(cols, rows, onData)
		},
		OpenSerial: func(path string, baud int, onData func([]byte)) (usecase.Shell, error) {
			return serialx.Open(path, baud, onData)
		},
		OpenTelnet: func(addr string, cols, rows int, user, pass string, onData func([]byte)) (usecase.Shell, error) {
			return telnetx.Open(addr, 10*time.Second, cols, rows, user, pass, onData)
		},
		ListSerial: serialx.Ports, Activity: db.ActivityLog()})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &App{Services: usecase.New(core), System: NewSystemService(), db: db, dir: dir}, nil
}

// Startup is the Wails OnStartup hook: it routes use case events to the frontend.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	a.System.SetContext(ctx)
	a.Core.SetEmitter(func(event string, data ...any) { runtime.EventsEmit(ctx, event, data...) })

	// The Settings window is a second process that talks to this one. Without the bridge the frontend
	// falls back to its in-app Settings window.
	a.bridge = NewBridge(a, func(service string) { runtime.EventsEmit(ctx, "bridge:changed", service) })
	if err := a.bridge.Start(a.dir); err == nil {
		a.launcher = NewSettingsLauncher(a.bridge)
		a.System.SetSettingsOpener(a.launcher.Open)
	}
}

// Shutdown is the Wails OnShutdown hook.
func (a *App) Shutdown(ctx context.Context) {
	if a.launcher != nil {
		a.launcher.Close()
	}
	if a.bridge != nil {
		a.bridge.Close()
	}
	a.Services.Shutdown()
	_ = a.db.Close()
}

// Menu is the application menu bar, wired to this window.
func (a *App) Menu() *menu.Menu {
	return BuildMenu(MenuHooks{
		Emit: func(action string) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, MenuEvent, action)
			}
		},
		OpenURL: func(url string) {
			if a.ctx != nil && urlAllowed(url) {
				runtime.BrowserOpenURL(a.ctx, url)
			}
		},
		ToggleFullScreen: func() {
			if a.ctx == nil {
				return
			}
			if runtime.WindowIsFullscreen(a.ctx) {
				runtime.WindowUnfullscreen(a.ctx)
			} else {
				runtime.WindowFullscreen(a.ctx)
			}
		},
	})
}
