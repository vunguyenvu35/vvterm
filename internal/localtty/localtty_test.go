package localtty

import (
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

type sink struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (s *sink) write(p []byte) { s.mu.Lock(); s.buf.Write(p); s.mu.Unlock() }
func (s *sink) text() string   { s.mu.Lock(); defer s.mu.Unlock(); return s.buf.String() }
func (s *sink) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(s.text(), want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("never saw %q in %q", want, s.text())
}

func TestShellOutputAndNormalExit(t *testing.T) {
	var out sink
	sh, err := OpenCommand(exec.Command("/bin/sh", "-c", "printf hello-pty; exit 3"), 80, 24, out.write)
	if err != nil {
		t.Fatal(err)
	}
	<-sh.Done()
	if err := sh.Err(); err != nil {
		t.Fatalf("a non-zero exit status is a normal end, not an error: %v", err)
	}
	out.waitFor(t, "hello-pty")
}

func TestInteractiveShellEchoesResizesAndCloses(t *testing.T) {
	var out sink
	sh, err := OpenCommand(exec.Command("/bin/sh"), 100, 30, out.write)
	if err != nil {
		t.Fatal(err)
	}
	defer sh.Close()
	if _, err := sh.Write([]byte("echo size:$(stty size)\n")); err != nil {
		t.Fatal(err)
	}
	out.waitFor(t, "size:30 100") // the PTY has the size we asked for
	if err := sh.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	sh.Write([]byte("echo again:$(stty size)\n"))
	out.waitFor(t, "again:40 120")
	sh.Close()
	select {
	case <-sh.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Close must end the shell")
	}
	sh.Close() // idempotent
}

func TestTerminalEnvironmentIsSet(t *testing.T) {
	var out sink
	sh, err := OpenCommand(exec.Command("/bin/sh", "-c", "echo term=$TERM"), 0, 0, out.write) // 0x0 falls back to 80x24
	if err != nil {
		t.Fatal(err)
	}
	<-sh.Done()
	out.waitFor(t, "term=xterm-256color")
}

func TestUserShellFallsBack(t *testing.T) {
	t.Setenv("SHELL", "/usr/bin/fish")
	if UserShell() != "/usr/bin/fish" {
		t.Fatal("must use $SHELL")
	}
	t.Setenv("SHELL", "")
	if s := UserShell(); s != "/bin/zsh" && s != "/bin/sh" {
		t.Fatalf("fallback %q", s)
	}
}

func TestOpenFailsForAMissingProgram(t *testing.T) {
	if _, err := OpenCommand(exec.Command("/nonexistent/program"), 80, 24, func([]byte) {}); err == nil {
		t.Fatal("expected an error")
	}
}
