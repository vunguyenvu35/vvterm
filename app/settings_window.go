package app

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// SettingsFlag is the command-line argument that starts the Settings window process.
const SettingsFlag = "--settings"

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
		cmd := exec.Command(exe, SettingsFlag)
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
		return nil
	}
	cmd, err := l.start()
	if err != nil {
		return err
	}
	l.cmd = cmd
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
