package app

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// SystemService offers native dialogs and app info. It is the only place that touches the
// Wails runtime for dialogs.
type SystemService struct {
	ctx          context.Context
	openSettings func() error
}

func NewSystemService() *SystemService { return &SystemService{} }

// SetContext is called from OnStartup with the Wails context.
func (s *SystemService) SetContext(ctx context.Context) { s.ctx = ctx }

type AppInfo struct {
	Version string `json:"version"`
}

// SetSettingsOpener installs what OpenSettings runs (the launcher of the Settings window process).
func (s *SystemService) SetSettingsOpener(f func() error) { s.openSettings = f }

// OpenSettings opens the Settings window (a second native window), or raises it. It fails when there
// is no native window to open, and the frontend then shows its in-app Settings window instead.
func (s *SystemService) OpenSettings() error {
	if s.noDialogs() || s.openSettings == nil {
		return errNoDialog
	}
	return s.openSettings()
}

func (s *SystemService) Info() AppInfo { return AppInfo{Version: Version} }

var errNoDialog = errors.New("native dialogs are not available in this environment")

// noDialogs is true without a Wails context, or when VVTERM_NO_NATIVE_DIALOGS is set (the end-to-end
// run sets it: the UI then falls back to simple prompts that a browser test can answer).
func (s *SystemService) noDialogs() bool {
	return s.ctx == nil || os.Getenv("VVTERM_NO_NATIVE_DIALOGS") != ""
}

func (s *SystemService) PickFile(title string) (string, error) {
	if s.noDialogs() {
		return "", errNoDialog
	}
	return runtime.OpenFileDialog(s.ctx, runtime.OpenDialogOptions{Title: title, ShowHiddenFiles: true})
}

func (s *SystemService) PickDirectory(title string) (string, error) {
	if s.noDialogs() {
		return "", errNoDialog
	}
	return runtime.OpenDirectoryDialog(s.ctx, runtime.OpenDialogOptions{Title: title, CanCreateDirectories: true})
}

func (s *SystemService) SaveFile(title, defaultName string) (string, error) {
	if s.noDialogs() {
		return "", errNoDialog
	}
	return runtime.SaveFileDialog(s.ctx, runtime.SaveDialogOptions{Title: title, DefaultFilename: defaultName})
}

// allowedURLPrefixes are the only links the app opens in the browser (About page).
var allowedURLPrefixes = []string{
	"https://github.com/vunguyenvu35/vvterm",
	"https://ko-fi.com/vunguyenvu",
}

func urlAllowed(u string) bool {
	for _, p := range allowedURLPrefixes {
		if u == p || strings.HasPrefix(u, p+"/") || strings.HasPrefix(u, p+"?") || strings.HasPrefix(u, p+"#") {
			return true
		}
	}
	return false
}

// OpenURL opens one of the project's own links in the default browser.
func (s *SystemService) OpenURL(url string) error {
	if !urlAllowed(url) {
		return errors.New("this link is not allowed")
	}
	if s.ctx == nil {
		return errNoDialog
	}
	runtime.BrowserOpenURL(s.ctx, url)
	return nil
}
