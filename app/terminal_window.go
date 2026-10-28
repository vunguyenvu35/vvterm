package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// WindowFlag starts a terminal window process: `vvterm --window <host id> <title>`.
const WindowFlag = "--window"

// WindowLauncher (main process) opens a terminal window as another process of this program. Like the
// Settings window it holds no data of its own: its session runs in the main process and its keystrokes
// and output travel through the bridge.
type WindowLauncher struct {
	mu    sync.Mutex
	cmds  map[*exec.Cmd]bool
	start func(hostID, title string) (*exec.Cmd, error)
}

// NewWindowLauncher starts the current executable with WindowFlag.
func NewWindowLauncher() *WindowLauncher {
	return &WindowLauncher{cmds: map[*exec.Cmd]bool{}, start: func(hostID, title string) (*exec.Cmd, error) {
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		cmd := exec.Command(exe, WindowFlag, hostID, title)
		cmd.Env = os.Environ()
		return cmd, cmd.Start()
	}}
}

// Open starts one more window; every call makes a new one.
func (l *WindowLauncher) Open(hostID, title string) error {
	cmd, err := l.start(hostID, title)
	if err != nil {
		return err
	}
	l.mu.Lock()
	l.cmds[cmd] = true
	l.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		l.mu.Lock()
		delete(l.cmds, cmd)
		l.mu.Unlock()
	}()
	return nil
}

// Close ends every open window when the main app quits.
func (l *WindowLauncher) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for c := range l.cmds {
		if c.Process != nil {
			_ = c.Process.Kill()
		}
	}
}

// WindowTarget is what a terminal window was opened for.
type WindowTarget struct {
	HostID string `json:"host_id"`
	Title  string `json:"title"`
}

// TerminalWindow is the application object of a terminal window process. It owns no data: calls go to
// the main process, and the output of its sessions is brought back as local events.
type TerminalWindow struct {
	System *SystemService
	target WindowTarget
	client *BridgeClient

	mu   sync.Mutex
	sids map[string]bool
}

// NewTerminalWindow connects to the main process through the file in dir.
func NewTerminalWindow(dir, hostID, title string) (*TerminalWindow, error) {
	c, err := ConnectBridge(dir)
	if err != nil {
		return nil, err
	}
	if err := c.Ping(); err != nil {
		return nil, err
	}
	return &TerminalWindow{System: NewSystemService(), target: WindowTarget{HostID: hostID, Title: title}, client: c, sids: map[string]bool{}}, nil
}

// Target says what this window shows.
func (w *TerminalWindow) Target() WindowTarget { return w.target }

// Call forwards one use case call to the main process (args and result are JSON text). The sessions
// this window opens are remembered so they end with the window.
func (w *TerminalWindow) Call(service, method, argsJSON string) (string, error) {
	out, err := w.client.Call(service, method, argsJSON)
	if err == nil && service == "SessionService" {
		switch method {
		case "Open":
			var sid string
			if json.Unmarshal([]byte(out), &sid) == nil && sid != "" {
				w.mu.Lock()
				w.sids[sid] = true
				w.mu.Unlock()
			}
		case "Close":
			var args []string
			if json.Unmarshal([]byte(argsJSON), &args) == nil && len(args) > 0 {
				w.mu.Lock()
				delete(w.sids, args[0])
				w.mu.Unlock()
			}
		}
	}
	return out, err
}

// Startup is the Wails OnStartup hook: it quits when the main app is gone and turns the events that the
// main process relays into events of this window, where the terminal listens for them.
func (w *TerminalWindow) Startup(ctx context.Context) {
	w.System.SetContext(ctx)
	quitWithMain(ctx, w.client)
	go func() {
		seq := 0
		// start after what is already queued: this window has not opened a session yet
		if _, last, err := w.client.Events(ctx, 1<<30); err == nil {
			seq = last
		}
		for ctx.Err() == nil {
			evs, last, err := w.client.Events(ctx, seq)
			if err != nil {
				time.Sleep(time.Second)
				continue
			}
			for _, e := range evs {
				var args []any
				if json.Unmarshal(e.Args, &args) == nil {
					runtime.EventsEmit(ctx, e.Name, args...)
				}
			}
			seq = last
		}
	}()
}

// Shutdown ends the sessions this window opened.
func (w *TerminalWindow) Shutdown(context.Context) {
	w.mu.Lock()
	sids := make([]string, 0, len(w.sids))
	for s := range w.sids {
		sids = append(sids, s)
	}
	w.mu.Unlock()
	for _, s := range sids {
		b, _ := json.Marshal([]string{s})
		_, _ = w.client.Call("SessionService", "Close", string(b))
	}
}
