package app

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// SettingsFlag is the command-line argument that starts the Settings window process.
const SettingsFlag = "--settings"

// RaiseProcess brings the window of another process of this app to the front (the macOS front-app rules need the
// app in front to hand it over). It returns false when that process cannot be raised yet. Set by the main package.
var RaiseProcess func(pid int) bool

// raise asks for the Settings window to come to the front, trying for a few seconds because a process registers
// with the window server a moment after it starts.
func raise(pid int) {
	if RaiseProcess == nil || pid <= 0 {
		return
	}
	go func() {
		for i := 0; i < 50; i++ {
			if RaiseProcess(pid) {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}()
}

// SettingsLauncher (main process) opens the Settings window as a second process, and brings the
// existing one to the front instead of opening another.
type SettingsLauncher struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	bridge *Bridge
	start  func() (*exec.Cmd, error)
}

// NewSettingsLauncher starts the current executable with SettingsFlag.
func NewSettingsLauncher(b *Bridge) *SettingsLauncher {
	return &SettingsLauncher{bridge: b, start: func() (*exec.Cmd, error) {
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		cmd := exec.Command(settingsExecutable(exe), SettingsFlag)
		cmd.Env = os.Environ()
		return cmd, cmd.Start()
	}}
}

// Open starts the Settings window, or raises it when it is already open.
func (l *SettingsLauncher) Open() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cmd != nil {
		l.bridge.RequestFocus()
		raise(l.cmd.Process.Pid)
		return nil
	}
	cmd, err := l.start()
	if err != nil {
		return err
	}
	l.cmd = cmd
	raise(cmd.Process.Pid)
	go func() {
		_ = cmd.Wait()
		l.mu.Lock()
		if l.cmd == cmd {
			l.cmd = nil
		}
		l.mu.Unlock()
	}()
	return nil
}

// Close ends the Settings window when the main app quits.
func (l *SettingsLauncher) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cmd != nil && l.cmd.Process != nil {
		_ = l.cmd.Process.Kill()
	}
}

// SettingsBridge is bound in the Settings process: the frontend sends every use case call through it.
type SettingsBridge struct{ client *BridgeClient }

// Call forwards one call to the main process (args and result are JSON text).
func (s *SettingsBridge) Call(service, method, argsJSON string) (string, error) {
	return s.client.Call(service, method, argsJSON)
}

// SettingsWindow is the application object of the Settings process. It owns no data.
type SettingsWindow struct {
	Bridge *SettingsBridge
	System *SystemService
	client *BridgeClient
	ctx    context.Context
}

// NewSettingsWindow connects to the main process through the file in dir.
func NewSettingsWindow(dir string) (*SettingsWindow, error) {
	c, err := ConnectBridge(dir)
	if err != nil {
		return nil, err
	}
	if err := c.Ping(); err != nil {
		return nil, err
	}
	return &SettingsWindow{Bridge: &SettingsBridge{client: c}, System: NewSystemService(), client: c}, nil
}

// Startup is the Wails OnStartup hook of the Settings process: it quits when the main app is gone and
// raises the window when the main app asks for it.
func (w *SettingsWindow) Startup(ctx context.Context) {
	w.ctx = ctx
	w.System.SetContext(ctx)
	quitWithMain(ctx, w.client)
	go func() {
		for ctx.Err() == nil {
			focus, err := w.client.WaitFocus(ctx)
			if err != nil {
				time.Sleep(time.Second)
				continue
			}
			if focus {
				runtime.WindowUnminimise(ctx)
				runtime.WindowShow(ctx)
			}
		}
	}()
}

// quitWithMain ends this process when the main process stops answering.
func quitWithMain(ctx context.Context, c *BridgeClient) {
	go func() {
		misses := 0
		for ctx.Err() == nil {
			time.Sleep(2 * time.Second)
			if c.Ping() != nil {
				if misses++; misses >= 3 {
					runtime.Quit(ctx)
					return
				}
				continue
			}
			misses = 0
		}
	}()
}

// Menu is the same menu bar as the main window's, so it does not change when Settings has the focus.
func (w *SettingsWindow) Menu() *menu.Menu {
	return menuViaMain(w.client, func() context.Context { return w.ctx })
}

// menuViaMain is the main window's menu bar for a window of another process: its items are done by the main
// window (through the bridge); only Full Screen and the Help links are done here.
func menuViaMain(c *BridgeClient, ctx func() context.Context) *menu.Menu {
	return BuildMenu(MenuHooks{
		Emit: func(action string) { go func() { _ = c.MenuAction(action) }() },
		OpenURL: func(url string) {
			if x := ctx(); x != nil && urlAllowed(url) {
				runtime.BrowserOpenURL(x, url)
			}
		},
		ToggleFullScreen: func() {
			x := ctx()
			if x == nil {
				return
			}
			if runtime.WindowIsFullscreen(x) {
				runtime.WindowUnfullscreen(x)
			} else {
				runtime.WindowFullscreen(x)
			}
		},
	})
}

// settingsExecutable is what to start for the Settings window. On macOS it is a helper bundle marked as having
// no Dock icon, so the window opens without the Dock reacting: the one a build made (Contents/Helpers, see
// scripts/macos-settings-helper.sh), or else one made on the fly in the cache folder, which is what happens
// under `make dev`. Anywhere else, and when no helper can be made, it is the app itself.
func settingsExecutable(exe string) string {
	helper := filepath.Join(filepath.Dir(exe), "..", "Helpers", "VVTerm Settings.app", "Contents", "MacOS", "vvterm-settings")
	if st, err := os.Stat(helper); err == nil && st.Mode().IsRegular() {
		return helper
	}
	if goruntime.GOOS == "darwin" {
		if cache, err := os.UserCacheDir(); err == nil {
			if h, err := prepareSettingsHelper(exe, filepath.Join(cache, "vvterm")); err == nil {
				return h
			}
		}
	}
	return exe
}

const settingsHelperPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleName</key><string>VVTerm Settings</string>
  <key>CFBundleExecutable</key><string>vvterm-settings</string>
  <key>CFBundleIdentifier</key><string>com.wails.vvterm.settings</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`

// prepareSettingsHelper makes (or refreshes) root/VVTerm Settings.app around exe and returns the helper's
// executable. It is a hard link to exe, so a rebuilt exe gets a new link the next time and nothing is copied;
// across disks it falls back to a copy.
func prepareSettingsHelper(exe, root string) (string, error) {
	bundle := filepath.Join(root, "VVTerm Settings.app")
	bin := filepath.Join(bundle, "Contents", "MacOS", "vvterm-settings")
	src, err := os.Stat(exe)
	if err != nil {
		return "", err
	}
	if dst, err := os.Stat(bin); err == nil && (os.SameFile(src, dst) || (dst.Size() == src.Size() && !dst.ModTime().Before(src.ModTime()))) {
		return bin, nil // already up to date
	}
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(bundle, "Contents", "Info.plist"), []byte(settingsHelperPlist), 0o644); err != nil {
		return "", err
	}
	_ = os.Remove(bin)
	if err := os.Link(exe, bin); err == nil {
		return bin, nil
	}
	in, err := os.Open(exe)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.OpenFile(bin, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return "", err
	}
	return bin, out.Close()
}
