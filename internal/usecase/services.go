package usecase

import (
	"errors"
)

// Services is the full set of use cases, built around one Core.
type Services struct {
	Core      *Core
	Host      *HostService
	Vault     *VaultService
	Session   *SessionService
	Forward   *ForwardService
	Sync      *SyncService
	ImportExp *ImportExportService
	Settings  *SettingsService
}

// New builds every use case service.
func New(core *Core) *Services {
	fwd := NewForwardService(core)
	return &Services{
		Core:      core,
		Host:      NewHostService(core),
		Vault:     NewVaultService(core),
		Session:   NewSessionService(core, fwd),
		Forward:   fwd,
		Sync:      NewSyncService(core),
		ImportExp: NewImportExportService(core),
		Settings:  NewSettingsService(core),
	}
}

// Shutdown stops forwards and sessions and locks the vault.
func (s *Services) Shutdown() {
	s.Forward.StopAll()
	s.Session.CloseAll()
	s.Core.Vault.Lock()
}

// SettingsService reads and writes settings.json (theme, font, auto-lock).
type SettingsService struct{ c *Core }

func NewSettingsService(c *Core) *SettingsService { return &SettingsService{c} }

func (s *SettingsService) Get() Settings {
	s.c.setMu.Lock()
	defer s.c.setMu.Unlock()
	return s.c.settings
}

// Save updates appearance settings. Sync URL and auto-lock have dedicated methods.
func (s *SettingsService) Save(in Settings) (Settings, error) {
	if in.FontSize < 8 || in.FontSize > 40 {
		return Settings{}, errors.New("font size must be between 8 and 40")
	}
	if in.Theme != "dark" && in.Theme != "light" {
		return Settings{}, errors.New("theme must be dark or light")
	}
	s.c.setMu.Lock()
	defer s.c.setMu.Unlock()
	s.c.settings.Theme = in.Theme
	s.c.settings.FontSize = in.FontSize
	if in.FontFamily != "" {
		s.c.settings.FontFamily = in.FontFamily
	}
	return s.c.settings, s.c.saveSettings()
}
