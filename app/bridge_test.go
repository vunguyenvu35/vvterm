package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
