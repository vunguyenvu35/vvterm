package app

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestWindowLauncherStartsEveryTimeAndClosesAll(t *testing.T) {
	var got [][2]string
	l := NewWindowLauncher()
	l.start = func(hostID, title string) (*exec.Cmd, error) {
		got = append(got, [2]string{hostID, title})
		cmd := exec.Command("sleep", "30")
		return cmd, cmd.Start()
	}
	if err := l.Open("h1", "web"); err != nil {
		t.Fatal(err)
	}
	if err := l.Open("h1", "web"); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != [2]string{"h1", "web"} {
		t.Fatalf("every Open is a new window: %v", got)
	}
	l.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		n := len(l.cmds)
		l.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("windows must end with the app")
}

func TestOpenWindowFallsBackWithoutNativeWindows(t *testing.T) {
	s := NewSystemService()
	if err := s.OpenWindow("h", "t"); err == nil {
		t.Fatal("no opener: the frontend says windows are not available")
	}
	var host, title string
	s.SetWindowOpener(func(h, tt string) error { host, title = h, tt; return nil })
	s.SetContext(context.Background())
	if err := s.OpenWindow("", "t"); err == nil {
		t.Fatal("nothing to open")
	}
	if err := s.OpenWindow("local", "Local"); err != nil || host != "local" || title != "Local" {
		t.Fatalf("%v %q %q", err, host, title)
	}
	t.Setenv("VVTERM_NO_NATIVE_DIALOGS", "1")
	if err := s.OpenWindow("local", "Local"); err == nil {
		t.Fatal("the e2e switch keeps everything in one window")
	}
}

func TestBridgeRelaysTheSessionsAWindowOpenedAndEveryOtherEvent(t *testing.T) {
	_, b, _, _ := newBridgeApp(t)
	b.Publish("term:data:other", []any{"x"}) // nobody opened it: not kept
	b.watch("mine")
	b.Publish("term:data:mine", []any{"aGk="})
	b.Publish("hosts:changed", []any{"h1"}) // not about one terminal: every app window gets it
	b.Publish("sftp:progress:theirs", []any{1}) // an SFTP session of another window: not kept
	b.Publish("sftp:progress:mine", []any{2})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	b.watch("mine")
	evs, last := b.eventsAfter(ctx, 0)
	if len(evs) != 3 || evs[0].Name != "term:data:mine" || evs[1].Name != "hosts:changed" || evs[2].Name != "sftp:progress:mine" || last != 3 {
		t.Fatalf("%+v last=%d", evs, last)
	}
	var args []string
	if json.Unmarshal(evs[0].Args, &args) != nil || args[0] != "aGk=" {
		t.Fatalf("%s", evs[0].Args)
	}
	// nothing new: the poll waits and then answers empty
	short, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	if evs, _ := b.eventsAfter(short, last); len(evs) != 0 {
		t.Fatal("no new events")
	}
}

func TestBridgeWakesAWaitingWindowAndBoundsWhatItKeeps(t *testing.T) {
	_, b, _, _ := newBridgeApp(t)
	b.watch("s")
	done := make(chan []BridgedEvent, 1)
	go func() {
		evs, _ := b.eventsAfter(context.Background(), 0)
		done <- evs
	}()
	time.Sleep(50 * time.Millisecond)
	b.Publish("term:ready:s", []any{map[string]any{"ok": true}})
	select {
	case evs := <-done:
		if len(evs) != 1 {
			t.Fatal(evs)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a waiting poll must wake up")
	}
	for i := 0; i < maxBridgedEvents+50; i++ {
		b.Publish("term:data:s", []any{"x"})
	}
	b.evMu.Lock()
	n := len(b.events)
	b.evMu.Unlock()
	if n > maxBridgedEvents {
		t.Fatalf("kept %d events", n)
	}
}

func TestBridgeAllowsSessionCallsButNotSessionTestsOrOtherServices(t *testing.T) {
	_, b, _, _ := newBridgeApp(t)
	if _, err := b.Dispatch("SessionService", "TestConnection", nil); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("TestConnection must stay in the main window: %v", err)
	}
	if _, err := b.Dispatch("VaultService", "Unlock", nil); err == nil {
		t.Fatal("the vault cannot be unlocked from a window")
	}
	if _, err := b.Dispatch("HostService", "DeleteHost", []json.RawMessage{json.RawMessage(`"x"`)}); err == nil {
		t.Fatal("a window only reads hosts")
	}
}

func TestMenuItemsOfOtherWindowsAreDoneByTheMainWindow(t *testing.T) {
	_, b, _, dir := newBridgeApp(t)
	var got []string
	b.SetMenuHandler(func(a string) { got = append(got, a) })
	c, err := ConnectBridge(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range MenuActions {
		if err := c.MenuAction(a); err != nil {
			t.Fatalf("%s: %v", a, err)
		}
	}
	if len(got) != len(MenuActions) {
		t.Fatalf("%d of %d actions arrived", len(got), len(MenuActions))
	}
	for _, bad := range []string{"", "rm -rf", "page:../x", "new_host\n"} {
		if err := c.MenuAction(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
	if len(got) != len(MenuActions) {
		t.Fatal("a refused action reached the handler")
	}
}

func TestAnAppWindowMayCallAnyUseCaseButOnlyThose(t *testing.T) {
	_, b, _, dir := newBridgeApp(t)
	for _, call := range [][2]string{{"HostService", "ListHosts"}, {"VaultService", "Status"}, {"SnippetService", "List"}, {"LocalService", "Home"}} {
		args := []json.RawMessage{}
		if call[1] == "ListHosts" {
			args = []json.RawMessage{json.RawMessage(`{"query":"","group_id":"","env":"","tag":""}`)}
		}
		if _, err := b.DispatchApp(call[0], call[1], args); err != nil {
			t.Errorf("%s.%s: %v", call[0], call[1], err)
		}
	}
	for _, call := range [][2]string{{"NopeService", "List"}, {"HostService", "nope"}, {"HostService", ""}, {"HostService", "ListHostsX"}, {"SystemService", "OpenURL"}} {
		if _, err := b.DispatchApp(call[0], call[1], nil); err == nil {
			t.Errorf("%s.%s must be refused", call[0], call[1])
		}
	}
	// over HTTP it needs the token like everything else
	c, err := ConnectBridge(dir)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := c.CallApp("VaultService", "Status", "[]"); err != nil || !strings.Contains(out, "exists") {
		t.Fatalf("%q %v", out, err)
	}
	c.token = "wrong"
	if _, err := c.CallApp("VaultService", "Status", "[]"); err == nil {
		t.Fatal("a wrong token must be refused")
	}
}

func TestAskingWhereTheEventsAreNowDoesNotWait(t *testing.T) {
	_, b, _, dir := newBridgeApp(t)
	b.watch("s")
	b.Publish("term:data:s", []any{"x"})
	c, _ := ConnectBridge(dir)
	start := time.Now()
	evs, last, err := c.Events(context.Background(), -1)
	if err != nil || len(evs) != 0 || last != 1 || time.Since(start) > 2*time.Second {
		t.Fatalf("%v %v %d %v", err, evs, last, time.Since(start))
	}
}
