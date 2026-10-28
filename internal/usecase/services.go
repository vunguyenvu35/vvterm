package usecase

import (
	"errors"
	"regexp"
	"strings"
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
	Snippet   *SnippetService
	Sftp      *SftpService
	Local     *LocalService
	Serial    *SerialService
	Log       *LogService
	KnownHost *KnownHostsService
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
		Snippet:   NewSnippetService(core),
		Sftp:      NewSftpService(core),
		Local:     NewLocalService(),
		Serial:    NewSerialService(core),
		Log:       NewLogService(core),
		KnownHost: NewKnownHostsService(core),
	}
}

// Shutdown stops forwards and sessions and locks the vault.
func (s *Services) Shutdown() {
	s.Forward.StopAll()
	s.Session.CloseAll()
	s.Sftp.CloseAll()
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

// Save updates appearance and terminal settings. Sync URL and auto-lock have dedicated methods.
func (s *SettingsService) Save(in Settings) (Settings, error) {
	if err := validateSettings(in); err != nil {
		return Settings{}, err
	}
	s.c.setMu.Lock()
	defer s.c.setMu.Unlock()
	s.c.settings.Theme = in.Theme
	s.c.settings.TerminalTheme = in.TerminalTheme
	s.c.settings.FontSize = in.FontSize
	s.c.settings.CursorStyle = in.CursorStyle
	s.c.settings.CursorBlink = in.CursorBlink
	s.c.settings.CopyOnSelect = in.CopyOnSelect
	s.c.settings.RightClick = in.RightClick
	s.c.settings.Scrollback = in.Scrollback
	s.c.settings.Zoom = in.Zoom
	s.c.settings.ConfirmTabClose = in.ConfirmTabClose
	s.c.settings.AskProtocol = in.AskProtocol
	s.c.settings.Highlight = in.Highlight
	s.c.settings.ReduceMotion = in.ReduceMotion
	s.c.settings.BiometricOnOpen = in.BiometricOnOpen
	s.c.settings.AccountName = strings.TrimSpace(in.AccountName)
	s.c.settings.AccountEmail = strings.TrimSpace(in.AccountEmail)
	s.c.settings.Shortcuts = cloneShortcuts(in.Shortcuts)
	if in.FontFamily != "" {
		s.c.settings.FontFamily = in.FontFamily
	}
	return s.c.settings, s.c.saveSettings()
}

var themeID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

func validateSettings(in Settings) error {
	switch in.RightClick {
	case "paste", "menu", "none":
	default:
		return errors.New("right click must be paste, menu or none")
	}
	switch in.Theme {
	case "auto", "light", "dark":
	default:
		return errors.New("theme must be auto, light or dark")
	}
	if in.TerminalTheme != "auto" && !themeID.MatchString(in.TerminalTheme) {
		return errors.New("invalid terminal theme")
	}
	if in.FontSize < 8 || in.FontSize > 40 {
		return errors.New("font size must be between 8 and 40")
	}
	switch in.CursorStyle {
	case "block", "bar", "underline":
	default:
		return errors.New("cursor style must be block, bar or underline")
	}
	if in.Scrollback < 500 || in.Scrollback > 100000 {
		return errors.New("scrollback must be between 500 and 100000 lines")
	}
	if in.Zoom < 80 || in.Zoom > 160 {
		return errors.New("zoom must be between 80 and 160 percent")
	}
	if err := validateAccount(in.AccountName, in.AccountEmail); err != nil {
		return err
	}
	if err := ValidateShortcuts(in.Shortcuts); err != nil {
		return err
	}
	if len(in.FontFamily) > 200 || strings.ContainsAny(in.FontFamily, "{};<>\n\r") {
		return errors.New("invalid font family")
	}
	return nil
}

func cloneShortcuts(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

var emailRe = regexp.MustCompile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

func validateAccount(name, email string) error {
	name, email = strings.TrimSpace(name), strings.TrimSpace(email)
	if len(name) > 80 || strings.ContainsAny(name, "\x00\r\n\t") {
		return errors.New("account name must be at most 80 characters and a single line")
	}
	if email != "" && (len(email) > 120 || !emailRe.MatchString(email)) {
		return errors.New("enter a valid email address")
	}
	return nil
}
