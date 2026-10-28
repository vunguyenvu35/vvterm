package sshx

import (
	"errors"
	"io"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Shell is an interactive PTY session on a Client.
type Shell struct {
	client *Client
	sess   *ssh.Session
	stdin  io.WriteCloser
	done   chan struct{}
	err    error
	once   sync.Once
}

// OpenShell requests an xterm-256color PTY and starts the login shell. onData receives
// merged stdout/stderr and must not block for long.
func (c *Client) OpenShell(cols, rows int, onData func([]byte)) (*Shell, error) {
	sess, err := c.NewSession()
	if err != nil {
		return nil, err
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		sess.Close()
		return nil, err
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	w := writerFunc(func(p []byte) (int, error) {
		b := make([]byte, len(p))
		copy(b, p)
		onData(b)
		return len(p), nil
	})
	sess.Stdout = w
	sess.Stderr = w
	if err := sess.Shell(); err != nil {
		sess.Close()
		return nil, err
	}
	sh := &Shell{client: c, sess: sess, stdin: stdin, done: make(chan struct{})}
	go func() {
		sh.err = sess.Wait()
		close(sh.done)
	}()
	return sh, nil
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func (s *Shell) Write(p []byte) (int, error) { return s.stdin.Write(p) }

func (s *Shell) Resize(cols, rows int) error { return s.sess.WindowChange(rows, cols) }

// Done is closed when the remote shell exits or the connection drops.
func (s *Shell) Done() <-chan struct{} { return s.done }

// Err is the exit status error, valid after Done is closed. A clean exit returns nil.
func (s *Shell) Err() error {
	<-s.done
	var ee *ssh.ExitError
	if errors.As(s.err, &ee) && ee.ExitStatus() == 0 {
		return nil
	}
	if errors.Is(s.err, io.EOF) {
		return nil
	}
	return s.err
}

// Close ends the session and the underlying connection chain.
func (s *Shell) Close() {
	s.once.Do(func() {
		s.sess.Close()
		s.client.Close()
	})
}

// Keepalive pings the server every interval. After maxMissed consecutive failures it
// closes the client and returns. It also returns when stop is closed.
func Keepalive(c *Client, interval time.Duration, maxMissed int, stop <-chan struct{}, onLost func()) {
	if interval <= 0 {
		return
	}
	if maxMissed < 1 {
		maxMissed = 3
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	missed := 0
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			res := make(chan error, 1)
			go func() { _, _, err := c.SendRequest("keepalive@openssh.com", true, nil); res <- err }()
			var err error
			select {
			case err = <-res:
			case <-time.After(interval):
				err = errors.New("keepalive timeout")
			case <-stop:
				return
			}
			if err == nil {
				missed = 0
				continue
			}
			missed++
			if missed >= maxMissed {
				c.Close()
				if onLost != nil {
					onLost()
				}
				return
			}
		}
	}
}
