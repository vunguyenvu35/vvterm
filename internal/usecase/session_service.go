package usecase

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/sshx"
)

const (
	outputBatchInterval = 16 * time.Millisecond
	outputBatchMax      = 64 * 1024
)

type session struct {
	sid    string
	hostID string

	mu     sync.Mutex
	cols   int
	rows   int
	client *sshx.Client
	shell  Shell
	closed bool
	abort  chan struct{} // closed on Close(sid) to cancel connecting
	stopKA chan struct{}

	// Until the frontend calls Attach, output is buffered and state events can be replayed,
	// so nothing emitted between Open returning and the listeners existing is lost.
	attached bool
	pend     []byte
	state    string // connecting | ready | closed
	closedEv any
	ready    any
}

const maxPending = 1 << 20

// SessionService owns terminal tabs. Output flows to the frontend via events and keystrokes
// come back through Write; the frontend never holds a socket or a secret.
type SessionService struct {
	c *Core
	f *ForwardService

	mu       sync.Mutex
	sessions map[string]*session
}

func NewSessionService(c *Core, f *ForwardService) *SessionService {
	s := &SessionService{c: c, f: f, sessions: map[string]*session{}}
	f.sessions = s
	return s
}

// Open starts connecting to a host and returns the session id immediately. Progress is
// reported through term:hostkey:<sid>, term:ready:<sid>, term:data:<sid>, term:closed:<sid>.
func (s *SessionService) Open(hostID string, cols, rows int) (string, error) {
	switch {
	case hostID == LocalHostID:
	case strings.HasPrefix(hostID, serialPrefix):
		if _, _, err := ParseSerialID(hostID); err != nil {
			return "", err
		}
	case strings.HasPrefix(hostID, telnetPrefix):
		h, err := s.c.Store.GetHost(strings.TrimPrefix(hostID, telnetPrefix))
		if err != nil {
			return "", fmt.Errorf("host: %w", err)
		}
		if !h.TelnetEnabled {
			return "", fmt.Errorf("Telnet is not enabled for %q: edit the host and turn it on", h.Label)
		}
	default:
		if _, err := s.c.Store.GetHost(hostID); err != nil {
			return "", fmt.Errorf("host: %w", err)
		}
	}
	if cols < 1 || rows < 1 {
		cols, rows = 80, 24
	}
	sess := &session{sid: domain.NewID(), hostID: hostID, cols: cols, rows: rows, abort: make(chan struct{})}
	s.mu.Lock()
	s.sessions[sess.sid] = sess
	s.mu.Unlock()
	go s.run(sess)
	return sess.sid, nil
}

func (s *SessionService) get(sid string) (*session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if x, ok := s.sessions[sid]; ok {
		return x, nil
	}
	return nil, errors.New("unknown session")
}

func (s *SessionService) run(sess *session) {
	if isDeviceID(sess.hostID) {
		s.runDevice(sess)
		return
	}
	sid := sess.sid
	closed := func(reason string, clean bool) {
		s.logEnd(sess, reason, clean)
		sess.mu.Lock()
		defer sess.mu.Unlock()
		sess.state = "closed"
		sess.closedEv = map[string]any{"reason": reason, "clean": clean}
		s.c.emit("term:closed:"+sid, sess.closedEv)
	}
	sess.mu.Lock()
	sess.state, sess.closedEv, sess.ready = "connecting", nil, nil
	sess.mu.Unlock()
	cl, host, err := s.c.connect(sess.hostID, sid, sess.abort)
	if err != nil {
		closed(err.Error(), false)
		return
	}
	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		cl.Close()
		return
	}
	cols, rows := sess.cols, sess.rows
	sess.mu.Unlock()

	batch := s.batcher(sess)
	sh, err := cl.OpenShell(cols, rows, batch.Write)
	if err != nil {
		cl.Close()
		closed(err.Error(), false)
		return
	}
	stop := make(chan struct{})
	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		sh.Close()
		return
	}
	sess.client, sess.shell, sess.stopKA = cl, sh, stop
	sess.mu.Unlock()

	go sshx.Keepalive(cl, time.Duration(host.KeepaliveSec)*time.Second, 3, stop, nil)
	s.c.learnOS(host, cl)
	s.f.autoStart(sid, cl, host.ID)
	sess.mu.Lock()
	sess.state, sess.ready = "ready", map[string]any{"host": host.Label}
	s.c.record(domain.ActConnect, host.ID, host.Label, fmt.Sprintf("Connected to %s:%d", host.Hostname, host.Port), true)
	s.c.emit("term:ready:"+sid, sess.ready)
	sess.mu.Unlock()

	<-sh.Done()
	err = sh.Err()
	close(stop)
	batch.Close()
	s.f.stopOwned(sid)
	sh.Close()

	sess.mu.Lock()
	wasClosed := sess.closed
	sess.client, sess.shell = nil, nil
	sess.mu.Unlock()
	if wasClosed {
		s.c.record(domain.ActDisconnect, sess.hostID, "", "Closed by you", true)
		return // user closed the tab: no event needed
	}
	if err == nil {
		closed("session ended", true)
		return
	}
	closed("connection lost: "+err.Error(), false)
}

// Attach tells the backend the frontend is now listening for this session's events. Output
// buffered so far is delivered and the current state (pending host key prompt, ready, closed)
// is replayed.
func (s *SessionService) Attach(sid string) error {
	sess, err := s.get(sid)
	if err != nil {
		return err
	}
	if p, ok := s.c.prompts.payload(sid); ok {
		s.c.emit("term:hostkey:"+sid, p)
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	switch sess.state {
	case "ready":
		s.c.emit("term:ready:"+sid, sess.ready)
	case "closed":
		s.c.emit("term:closed:"+sid, sess.closedEv)
	}
	if len(sess.pend) > 0 {
		s.c.emit("term:data:"+sid, base64.StdEncoding.EncodeToString(sess.pend))
		sess.pend = nil
	}
	sess.attached = true
	return nil
}

// Write sends keystrokes to the remote stdin.
func (s *SessionService) Write(sid, data string) error {
	sess, err := s.get(sid)
	if err != nil {
		return err
	}
	sess.mu.Lock()
	sh := sess.shell
	sess.mu.Unlock()
	if sh == nil {
		return errors.New("session is not connected")
	}
	_, err = sh.Write([]byte(data))
	return err
}

// Resize applies a new terminal size; sizes requested while connecting are used at PTY creation.
func (s *SessionService) Resize(sid string, cols, rows int) error {
	if cols < 1 || rows < 1 {
		return errors.New("invalid size")
	}
	sess, err := s.get(sid)
	if err != nil {
		return err
	}
	sess.mu.Lock()
	sess.cols, sess.rows = cols, rows
	sh := sess.shell
	sess.mu.Unlock()
	if sh == nil {
		return nil
	}
	return sh.Resize(cols, rows)
}

// Reconnect re-runs the connection for a session whose link dropped (user pressed Enter).
// It never happens automatically so commands are not replayed by surprise.
func (s *SessionService) Reconnect(sid string, cols, rows int) error {
	sess, err := s.get(sid)
	if err != nil {
		return err
	}
	sess.mu.Lock()
	if sess.shell != nil {
		sess.mu.Unlock()
		return errors.New("session is still connected")
	}
	if cols > 0 && rows > 0 {
		sess.cols, sess.rows = cols, rows
	}
	sess.closed = false
	sess.abort = make(chan struct{})
	sess.mu.Unlock()
	go s.run(sess)
	return nil
}

// Close ends the session, its forwards and any connection in progress.
func (s *SessionService) Close(sid string) error {
	s.mu.Lock()
	sess, ok := s.sessions[sid]
	delete(s.sessions, sid)
	s.mu.Unlock()
	if !ok {
		return errors.New("unknown session")
	}
	sess.mu.Lock()
	sess.closed = true
	select {
	case <-sess.abort:
	default:
		close(sess.abort)
	}
	sh := sess.shell
	sess.mu.Unlock()
	s.f.stopOwned(sid)
	s.c.prompts.clear(sid)
	if sh != nil {
		sh.Close()
	}
	return nil
}

// TrustHostKey answers a term:hostkey:<key> event. The fingerprint must equal the one displayed.
// Passing an empty fingerprint rejects the key.
func (s *SessionService) TrustHostKey(sid, fingerprint string) error {
	return s.c.prompts.answer(sid, fingerprint, fingerprint != "")
}

// activeClient returns a connected client for hostID, if a terminal session is open on it.
func (s *SessionService) activeClient(hostID string) (*sshx.Client, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sid, x := range s.sessions {
		x.mu.Lock()
		cl, ok := x.client, x.hostID == hostID
		x.mu.Unlock()
		if ok && cl != nil {
			return cl, sid
		}
	}
	return nil, ""
}

// CloseAll terminates every session (app shutdown).
func (s *SessionService) CloseAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		_ = s.Close(id)
	}
}

// batcher collects terminal output for a short while and sends it to the frontend in few events; until the
// frontend attached, it is kept (up to maxPending) and replayed by Attach.
func (s *SessionService) batcher(sess *session) *sshx.Batcher {
	return sshx.NewBatcher(outputBatchInterval, outputBatchMax, func(p []byte) {
		sess.mu.Lock()
		defer sess.mu.Unlock()
		if !sess.attached {
			if len(sess.pend)+len(p) <= maxPending {
				sess.pend = append(sess.pend, p...)
			}
			return
		}
		s.c.emit("term:data:"+sess.sid, base64.StdEncoding.EncodeToString(p))
	})
}

func (s *SessionService) markClosed(sess *session, reason string, clean bool) {
	s.logEnd(sess, reason, clean)
	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.state = "closed"
	sess.closedEv = map[string]any{"reason": reason, "clean": clean}
	s.c.emit("term:closed:"+sess.sid, sess.closedEv)
}

// runDevice runs a session that has no SSH connection: a shell on this computer or a serial port. There is
// no host key, no jump chain, no keepalive and no forwards; everything else (events, buffering, resize,
// reconnect with Enter, close) is shared with SSH sessions.
func (s *SessionService) runDevice(sess *session) {
	sess.mu.Lock()
	sess.state, sess.closedEv, sess.ready = "connecting", nil, nil
	cols, rows := sess.cols, sess.rows
	sess.mu.Unlock()

	batch := s.batcher(sess)
	var (
		sh    Shell
		err   error
		label string
	)
	if sess.hostID == LocalHostID {
		label = "This computer"
		if s.c.OpenLocalShell == nil {
			err = errors.New("the local terminal is not available in this build")
		} else {
			sh, err = s.c.OpenLocalShell(cols, rows, batch.Write)
		}
	} else if strings.HasPrefix(sess.hostID, telnetPrefix) {
		sh, label, err = s.openTelnet(sess, cols, rows, batch.Write)
	} else {
		var path string
		var baud int
		if path, baud, err = ParseSerialID(sess.hostID); err == nil {
			label = path
			if s.c.OpenSerial == nil {
				err = errors.New("serial ports are not available in this build")
			} else {
				sh, err = s.c.OpenSerial(path, baud, batch.Write)
			}
		}
	}
	if err != nil {
		batch.Close()
		s.markClosed(sess, err.Error(), false)
		return
	}
	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		sh.Close()
		batch.Close()
		return
	}
	sess.shell = sh
	sess.state, sess.ready = "ready", map[string]any{"host": label}
	s.c.record(domain.ActConnect, sess.hostID, label, s.openedMessage(sess, label), true)
	s.c.emit("term:ready:"+sess.sid, sess.ready)
	sess.mu.Unlock()

	<-sh.Done()
	err = sh.Err()
	batch.Close()
	sh.Close()

	sess.mu.Lock()
	wasClosed := sess.closed
	sess.shell = nil
	sess.mu.Unlock()
	if wasClosed {
		s.c.record(domain.ActDisconnect, sess.hostID, "", "Closed by you", true)
		return
	}
	if err == nil {
		s.markClosed(sess, "session ended", true)
		return
	}
	s.markClosed(sess, "connection lost: "+err.Error(), false)
}

// openTelnet connects a Telnet session for a saved host.
func (s *SessionService) openTelnet(sess *session, cols, rows int, onData func([]byte)) (Shell, string, error) {
	h, err := s.c.Store.GetHost(strings.TrimPrefix(sess.hostID, telnetPrefix))
	if err != nil {
		return nil, "", err
	}
	if s.c.OpenTelnet == nil {
		return nil, h.Label, errors.New("Telnet is not available in this build")
	}
	addr, user, pass, err := s.c.telnetCredentials(h)
	if err != nil {
		return nil, h.Label, err
	}
	sh, err := s.c.OpenTelnet(addr, cols, rows, user, pass, onData)
	return sh, h.Label, err
}

// openedMessage is the log line for a session that has no SSH connection.
func (s *SessionService) openedMessage(sess *session, label string) string {
	switch {
	case sess.hostID == LocalHostID:
		return "Opened a terminal on this computer"
	case strings.HasPrefix(sess.hostID, telnetPrefix):
		return "Connected with Telnet (unencrypted) to " + label
	}
	return "Opened the serial port " + label
}
