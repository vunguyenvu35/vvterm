// Package localtty runs a shell on this computer behind a pseudo-terminal: the "Terminal" tab, like
// the Terminal app but inside VVTerm. It implements the usecase.Shell port.
package localtty

import (
	"errors"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// Shell is a running local process on a PTY.
type Shell struct {
	cmd  *exec.Cmd
	tty  *os.File
	done chan struct{}
	err  error
	once sync.Once
}

// UserShell is what the user's account runs: $SHELL, else /bin/zsh on macOS and /bin/sh elsewhere.
func UserShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	if _, err := os.Stat("/bin/zsh"); err == nil {
		return "/bin/zsh"
	}
	return "/bin/sh"
}

// Open starts the user's login shell in their home folder. onData receives the terminal output and must
// not block for long.
func Open(cols, rows int, onData func([]byte)) (*Shell, error) {
	cmd := exec.Command(UserShell(), "-l")
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	return OpenCommand(cmd, cols, rows, onData)
}

// OpenCommand runs any command on a PTY (used by tests with a tiny script).
func OpenCommand(cmd *exec.Cmd, cols, rows int, onData func([]byte)) (*Shell, error) {
	if cols < 1 || rows < 1 {
		cols, rows = 80, 24
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	tty, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	s := &Shell{cmd: cmd, tty: tty, done: make(chan struct{})}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := tty.Read(buf)
			if n > 0 {
				onData(append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				break // EIO when the process ended
			}
		}
		werr := cmd.Wait()
		var ee *exec.ExitError
		if werr != nil && !errors.As(werr, &ee) {
			s.err = werr
		}
		tty.Close()
		close(s.done)
	}()
	return s, nil
}

func (s *Shell) Write(p []byte) (int, error) { return s.tty.Write(p) }

func (s *Shell) Resize(cols, rows int) error {
	return pty.Setsize(s.tty, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// Done is closed when the process has ended.
func (s *Shell) Done() <-chan struct{} { return s.done }

// Err is nil for a normal end (including a non-zero exit status: the shell simply exited).
func (s *Shell) Err() error { <-s.done; return s.err }

// Close hangs up the terminal and stops the process group.
func (s *Shell) Close() {
	s.once.Do(func() {
		s.killProcessGroup()
		s.tty.Close()
	})
}
