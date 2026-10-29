package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vvterm/internal/vault"
)

func newBridgeApp(t *testing.T) (*App, *Bridge, *[]string, string) {
	t.Helper()
	dir := t.TempDir()
	a, err := Build(dir, vault.NewMemKeychain(), &vault.KDFParams{Memory: 64, Time: 1, Threads: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.db.Close() })
	var changed []string
	b := NewBridge(a, func(s string) { changed = append(changed, s) })
	if err := b.Start(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	return a, b, &changed, dir
}

func TestBridgeConnectionFileIsPrivateAndRemovedOnClose(t *testing.T) {
	dir := t.TempDir()
	a, _ := Build(dir, vault.NewMemKeychain(), nil)
	defer a.db.Close()
	b := NewBridge(a, nil)
	if err := b.Start(dir); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, bridgeFile))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("connection file: %v %v", st, err)
	}
	b.Close()
	if _, err := os.Stat(filepath.Join(dir, bridgeFile)); !os.IsNotExist(err) {
		t.Fatal("the connection file must be removed on close")
	}
}

func TestBridgeCallsSettingsAndNotifiesTheMainWindow(t *testing.T) {
	_, _, changed, dir := newBridgeApp(t)
	c, err := ConnectBridge(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Ping(); err != nil {
		t.Fatal(err)
	}
	got, err := c.Call("SettingsService", "Get", "[]")
	if err != nil {
		t.Fatal(err)
	}
	var s map[string]any
	if err := json.Unmarshal([]byte(got), &s); err != nil || s["zoom"] == nil {
		t.Fatalf("%s %v", got, err)
	}
	if len(*changed) != 0 {
		t.Fatalf("reading must not notify: %v", *changed)
	}
	s["zoom"] = 120
	arg, _ := json.Marshal([]any{s})
	saved, err := c.Call("SettingsService", "Save", string(arg))
	if err != nil || !strings.Contains(saved, `"zoom":120`) {
		t.Fatalf("%s %v", saved, err)
	}
	if len(*changed) != 1 || (*changed)[0] != "SettingsService" {
		t.Fatalf("the main window must be told: %v", *changed)
	}
}

func TestBridgePassesUseCaseErrorsThrough(t *testing.T) {
	_, _, _, dir := newBridgeApp(t)
	c, _ := ConnectBridge(dir)
	arg, _ := json.Marshal([]any{map[string]any{"zoom": 5000}})
	if _, err := c.Call("SettingsService", "Save", string(arg)); err == nil || !strings.Contains(err.Error(), "must be") {
		t.Fatalf("want the validation error, got %v", err)
	}
}

func TestBridgeOnlyExposesTheAllowList(t *testing.T) {
	_, _, changed, dir := newBridgeApp(t)
	c, _ := ConnectBridge(dir)
	for _, call := range [][2]string{
		{"VaultService", "Unlock"}, {"VaultService", "ListIdentities"}, {"VaultService", "AddPassword"},
		{"HostService", "DeleteHost"}, {"SessionService", "TestConnection"}, {"SftpService", "Open"}, {"NopeService", "Get"}, {"SettingsService", "Nope"},
	} {
		if _, err := c.Call(call[0], call[1], "[]"); err == nil || !strings.Contains(err.Error(), "not available") {
			t.Errorf("%s.%s must be refused, got %v", call[0], call[1], err)
		}
	}
	if len(*changed) != 0 {
		t.Fatalf("refused calls must not notify: %v", *changed)
	}
}

func TestBridgeChecksArgumentCountAndTypes(t *testing.T) {
	_, _, _, dir := newBridgeApp(t)
	c, _ := ConnectBridge(dir)
	if _, err := c.Call("VaultService", "SetAutoLock", "[]"); err == nil || !strings.Contains(err.Error(), "argument") {
		t.Fatalf("missing argument: %v", err)
	}
	if _, err := c.Call("VaultService", "SetAutoLock", `["x"]`); err == nil {
		t.Fatal("a string is not minutes")
	}
	if _, err := c.Call("VaultService", "Status", ""); err != nil {
		t.Fatalf("no arguments at all must work: %v", err)
	}
}

func TestBridgeRejectsAWrongToken(t *testing.T) {
	_, _, _, dir := newBridgeApp(t)
	c, _ := ConnectBridge(dir)
	c.token = "guess"
	if err := c.Ping(); err == nil {
		t.Fatal("ping with a wrong token must fail")
	}
	if _, err := c.Call("SettingsService", "Get", "[]"); err == nil {
		t.Fatal("call with a wrong token must fail")
	}
}

func TestBridgeFocusRequestWakesTheSettingsWindow(t *testing.T) {
	_, b, _, dir := newBridgeApp(t)
	c, _ := ConnectBridge(dir)
	b.RequestFocus()
	b.RequestFocus() // coalesced
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got, err := c.WaitFocus(ctx)
	if err != nil || !got {
		t.Fatalf("%v %v", got, err)
	}
}

func TestConnectBridgeExplainsWhenTheMainAppIsNotRunning(t *testing.T) {
	if _, err := ConnectBridge(t.TempDir()); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("%v", err)
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, bridgeFile), []byte("{"), 0o600)
	if _, err := ConnectBridge(dir); err == nil {
		t.Fatal("a broken file must be reported")
	}
}

func TestSettingsLauncherOpensOnceAndRaisesAfterwards(t *testing.T) {
	_, b, _, _ := newBridgeApp(t)
	starts := 0
	l := NewSettingsLauncher(b)
	l.start = func() (*exec.Cmd, error) {
		starts++
		cmd := exec.Command("sleep", "30")
		return cmd, cmd.Start()
	}
	defer l.Close()
	if err := l.Open(); err != nil {
		t.Fatal(err)
	}
	if err := l.Open(); err != nil {
		t.Fatal(err)
	}
	if starts != 1 {
		t.Fatalf("a second Open must raise the window, not start another (starts=%d)", starts)
	}
	select {
	case <-b.focus:
	default:
		t.Fatal("the second Open must request focus")
	}
	l.Close() // the window process ends: the next Open starts a new one
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		gone := l.cmd == nil
		l.mu.Unlock()
		if gone {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := l.Open(); err != nil || starts != 2 {
		t.Fatalf("restart: %v starts=%d", err, starts)
	}
}

func TestOpenSettingsFallsBackWithoutNativeWindows(t *testing.T) {
	s := NewSystemService()
	if err := s.OpenSettings(); err == nil {
		t.Fatal("no opener: the frontend must fall back to its in-app window")
	}
	called := 0
	s.SetSettingsOpener(func() error { called++; return nil })
	s.SetContext(context.Background())
	if err := s.OpenSettings(); err != nil || called != 1 {
		t.Fatalf("%v %d", err, called)
	}
	t.Setenv("VVTERM_NO_NATIVE_DIALOGS", "1")
	if err := s.OpenSettings(); err == nil || called != 1 {
		t.Fatal("the e2e switch must keep the in-app window")
	}
}

// Locking the vault ends the Settings window, whether the user locked it or the inactivity timer did.
func TestLockingTheVaultClosesTheSettingsWindow(t *testing.T) {
	a, b, _, _ := newBridgeApp(t)
	if err := a.Vault.Create("a long master password"); err != nil {
		t.Fatal(err)
	}
	var cmd *exec.Cmd
	a.launcher = &SettingsLauncher{bridge: b, start: func() (*exec.Cmd, error) {
		cmd = exec.Command("sleep", "30")
		return cmd, cmd.Start()
	}}
	a.Core.SetEmitter(func(event string, data ...any) { a.closeSettingsWhenLocked(event) })
	if err := a.launcher.Open(); err != nil {
		t.Fatal(err)
	}
	a.Vault.Lock()
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("the Settings window must end when the vault locks")
	}
	// other events leave it alone
	if err := a.Vault.Unlock("a long master password"); err != nil {
		t.Fatal(err)
	}
	a.launcher.mu.Lock()
	a.launcher.cmd = nil
	a.launcher.mu.Unlock()
	if err := a.launcher.Open(); err != nil {
		t.Fatal(err)
	}
	a.closeSettingsWhenLocked("hosts:changed")
	time.Sleep(200 * time.Millisecond)
	if cmd.ProcessState != nil {
		t.Fatal("an unrelated event must not close Settings")
	}
	_ = cmd.Process.Kill()
}

// The Settings window can configure the assistant but never drive a terminal with it: asking, running or
// inserting commands, confirming a tool and sharing the screen stay with the main window.
func TestSettingsWindowCanConfigureTheAssistantButNotUseIt(t *testing.T) {
	a, _, _, dir := newBridgeApp(t)
	if err := a.Vault.Create("a long master password"); err != nil {
		t.Fatal(err)
	}
	c, _ := ConnectBridge(dir)
	out, err := c.Call("AssistantService", "Providers", "[]")
	if err != nil {
		t.Fatalf("Providers must be reachable: %v", err)
	}
	for _, id := range []string{`"claude"`, `"codex"`, `"gemini"`} {
		if !strings.Contains(out, id) {
			t.Errorf("the real app must offer %s: %s", id, out)
		}
	}
	if !strings.Contains(out, `"enabled":false`) || strings.Contains(out, `"enabled":true`) {
		t.Fatalf("every provider starts off: %s", out)
	}
	if _, err := c.Call("AssistantService", "Settings", "[]"); err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{"Ask", "Run", "Insert", "ConfirmTool", "ConfirmShare", "Preview", "SessionInfo", "SetHostPolicy", "CheckCommand", "Cancel", "ForgetSession"} {
		if _, err := c.Call("AssistantService", m, "[]"); err == nil || !strings.Contains(err.Error(), "not available") {
			t.Errorf("AssistantService.%s must be refused from the Settings window, got %v", m, err)
		}
	}
}

// The Settings window is raised in front of the main window after it starts and again when it is asked for twice;
// the raise is retried because a new process registers with the window server a moment late.
func TestSettingsWindowIsRaisedAfterItStartsAndWhenAskedAgain(t *testing.T) {
	_, b, _, _ := newBridgeApp(t)
	var mu sync.Mutex
	var pids []int
	attempts := 0
	old := RaiseProcess
	t.Cleanup(func() { RaiseProcess = old })
	RaiseProcess = func(pid int) bool {
		mu.Lock()
		defer mu.Unlock()
		attempts++
		pids = append(pids, pid)
		return attempts > 2 // the process is not known to the window server at first
	}
	var cmd *exec.Cmd
	l := &SettingsLauncher{bridge: b, start: func() (*exec.Cmd, error) {
		cmd = exec.Command("sleep", "30")
		return cmd, cmd.Start()
	}}
	t.Cleanup(func() { l.Close() })
	if err := l.Open(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := attempts
		mu.Unlock()
		if n >= 3 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	if attempts != 3 || pids[0] != cmd.Process.Pid {
		t.Fatalf("raise must be retried until it works, for the Settings process: attempts=%d pids=%v", attempts, pids)
	}
	mu.Unlock()
	if err := l.Open(); err != nil { // already open: raised again, no second process
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if attempts != 4 {
		t.Fatalf("asking again must raise the same window once more: %d", attempts)
	}
}
