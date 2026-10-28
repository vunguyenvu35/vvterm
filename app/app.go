// Package app is the delivery layer: it adapts the use cases to Wails bindings and events and
// is the composition root that builds the concrete adapters (storage, vault, keychain).
package app

import (
	"context"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"vvterm/internal/sqlitedb"
	"vvterm/internal/store"
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
	core, err := usecase.NewCore(dir, usecase.Options{Store: st, Vault: v})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &App{Services: usecase.New(core), System: NewSystemService(), db: db}, nil
}

// Startup is the Wails OnStartup hook: it routes use case events to the frontend.
func (a *App) Startup(ctx context.Context) {
	a.System.SetContext(ctx)
	a.Core.SetEmitter(func(event string, data ...any) { runtime.EventsEmit(ctx, event, data...) })
}

// Shutdown is the Wails OnShutdown hook.
func (a *App) Shutdown(ctx context.Context) {
	a.Services.Shutdown()
	_ = a.db.Close()
}
