package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	runtime2 "runtime"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// SystemService offers native dialogs and app info. It is the only place that touches the
// Wails runtime for dialogs.
type SystemService struct {
	ctx          context.Context
	openSettings func() error
	openWindow   func(hostID, title string) error
	menuFor      func(shortcuts map[string]string) *menu.Menu
	menuKeys     map[string]string
}

func NewSystemService() *SystemService { return &SystemService{} }

// SetContext is called from OnStartup with the Wails context.
func (s *SystemService) SetContext(ctx context.Context) { s.ctx = ctx }

type AppInfo struct {
	Version string `json:"version"`
}

// SetSettingsOpener installs what OpenSettings runs (the launcher of the Settings window process).
func (s *SystemService) SetSettingsOpener(f func() error) { s.openSettings = f }

// SetMenuBuilder installs what makes this window's menu bar for a set of shortcuts.
func (s *SystemService) SetMenuBuilder(f func(shortcuts map[string]string) *menu.Menu) { s.menuFor = f }

// SetMenuShortcuts is called by the page with the effective shortcuts (every action id to its key): the menu
// bar is made again so each item shows its key. It does nothing when the keys did not change.
func (s *SystemService) SetMenuShortcuts(shortcuts map[string]string) {
	if s.ctx == nil || s.menuFor == nil || runtime2.GOOS != "darwin" {
		return
	}
	if len(shortcuts) == len(s.menuKeys) {
		same := true
		for k, v := range shortcuts {
			if s.menuKeys[k] != v {
				same = false
				break
			}
		}
		if same {
			return
		}
	}
	s.menuKeys = shortcuts
	runtime.MenuSetApplicationMenu(s.ctx, s.menuFor(shortcuts))
	runtime.MenuUpdateApplicationMenu(s.ctx)
}

// OpenSettings opens the Settings window (a second native window), or raises it. It fails when there
// is no native window to open, and the frontend then shows its in-app Settings window instead.
func (s *SystemService) OpenSettings() error {
	if s.noDialogs() || s.openSettings == nil {
		return errNoDialog
	}
	return s.openSettings()
}

// SetWindowOpener installs what OpenWindow runs (the launcher of terminal window processes).
func (s *SystemService) SetWindowOpener(f func(hostID, title string) error) { s.openWindow = f }

// OpenWindow opens a new native window with a new session to the same place (a host, this computer, a
// serial port). It fails when there are no native windows, and the frontend says so.
func (s *SystemService) OpenWindow(hostID, title string) error {
	if s.noDialogs() || s.openWindow == nil {
		return errNoDialog
	}
	if hostID == "" {
		return errors.New("nothing to open")
	}
	return s.openWindow(hostID, title)
}

// riskyExt are files that run when they are opened: they are never opened from here, whatever their source.
var riskyExt = map[string]bool{
	".command": true, ".app": true, ".sh": true, ".bash": true, ".zsh": true, ".csh": true, ".pkg": true, ".dmg": true, ".workflow": true,
	".terminal": true, ".exe": true, ".bat": true, ".cmd": true, ".com": true, ".scr": true, ".msi": true, ".ps1": true, ".vbs": true,
	".jar": true, ".desktop": true, ".action": true, ".scpt": true, ".applescript": true,
}

func openCommand(path, with string) (*exec.Cmd, error) {
	if riskyExt[strings.ToLower(filepath.Ext(path))] {
		return nil, errors.New("this kind of file runs programs: it is not opened from here")
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() && runtime2.GOOS != "darwin" {
		return nil, errors.New("not a file that can be opened")
	}
	switch runtime2.GOOS {
	case "darwin":
		if with != "" {
			return exec.Command("open", "-a", with, path), nil
		}
		return exec.Command("open", path), nil
	case "windows":
		if with != "" {
			return exec.Command(with, path), nil
		}
		return exec.Command("cmd", "/c", "start", "", path), nil
	default:
		if with != "" {
			return exec.Command(with, path), nil
		}
		return exec.Command("xdg-open", path), nil
	}
}

// OpenPath opens a file with the application the system has for it.
func (s *SystemService) OpenPath(path string) error { return s.openFile(path, "") }

// OpenPathWith opens a file with the application chosen by the user (an app bundle or a program).
func (s *SystemService) OpenPathWith(path, app string) error { return s.openFile(path, app) }

func (s *SystemService) openFile(path, with string) error {
	if s.noDialogs() {
		return errNoDialog
	}
	if !filepath.IsAbs(path) {
		return errors.New("an absolute path is needed")
	}
	cmd, err := openCommand(path, with)
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
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

// maxClipboard bounds what is moved through the clipboard in one go.
const maxClipboard = 10 << 20

// ClipboardText returns the text on the system clipboard (the terminal's paste). It fails where there is no
// native window; the frontend then asks the browser instead.
func (s *SystemService) ClipboardText() (string, error) {
	if s.noDialogs() {
		return "", errNoDialog
	}
	t, err := runtime.ClipboardGetText(s.ctx)
	if len(t) > maxClipboard {
		t = t[:maxClipboard]
	}
	return t, err
}

// SetClipboardText puts text on the system clipboard (the terminal's copy).
func (s *SystemService) SetClipboardText(text string) error {
	if s.noDialogs() {
		return errNoDialog
	}
	if len(text) > maxClipboard {
		return errors.New("that is too much text for the clipboard")
	}
	return runtime.ClipboardSetText(s.ctx, text)
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
