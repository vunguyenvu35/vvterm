// Package telnetx is a small Telnet client (RFC 854 and friends) for the hosts that offer nothing else:
// switches, routers, old appliances. It implements the usecase.Shell port.
//
// Telnet is not encrypted: everything, the password included, crosses the network in clear. That is why a
// host must opt in to it, and why the password is sent at most once, only in answer to the login prompt of
// the first seconds of a connection.
package telnetx

import (
	"bytes"
	"errors"
	"io"
	"net"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Telnet commands and options.
const (
	iac  = 255
	dont = 254
	do   = 253
	wont = 252
	will = 251
	sb   = 250
	se   = 240

	optEcho  = 1
	optSGA   = 3
	optTType = 24
	optNAWS  = 31

	ttypeIs   = 0
	ttypeSend = 1
)

// autoLoginWindow is how long after connecting a login prompt may be answered. A later "Password:" is
// something else (sudo, su), never the stored password.
var autoLoginWindow = 30 * time.Second

var (
	userPrompt = regexp.MustCompile(`(?i)(login|username|user name|user)\s*:\s*$`)
	passPrompt = regexp.MustCompile(`(?i)pass(word|phrase)\s*:\s*$`)
)

// Shell is an open Telnet connection.
type Shell struct {
	conn  net.Conn
	done  chan struct{}
	err   error
	once  sync.Once
	wmu   sync.Mutex // serialises writes: keystrokes and negotiation replies
	state sync.Mutex
	cols  int
	rows  int

	him map[byte]bool // options we asked the server to use (DO sent)
	us  map[byte]bool // options we offered (WILL sent)

	user, pass         string
	start              time.Time
	sentUser, sentPass bool
	tail               string

	closedByUs atomic.Bool
}

// Open connects to addr ("host:port"). A non-empty user and pass are typed at the login prompt.
func Open(addr string, timeout time.Duration, cols, rows int, user, pass string, onData func([]byte)) (*Shell, error) {
	if cols < 1 || rows < 1 {
		cols, rows = 80, 24
	}
	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	s := &Shell{conn: c, done: make(chan struct{}), cols: cols, rows: rows, him: map[byte]bool{}, us: map[byte]bool{},
		user: user, pass: pass, start: time.Now()}
	go s.read(onData)
	return s, nil
}

func (s *Shell) send(b ...byte) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, _ = s.conn.Write(b)
}

func (s *Shell) naws() {
	s.state.Lock()
	cols, rows := s.cols, s.rows
	s.state.Unlock()
	msg := []byte{iac, sb, optNAWS}
	for _, v := range []int{cols, rows} {
		hi, lo := byte(v>>8), byte(v)
		for _, b := range []byte{hi, lo} {
			msg = append(msg, b)
			if b == iac {
				msg = append(msg, iac) // 255 inside a subnegotiation is doubled
			}
		}
	}
	s.send(append(msg, iac, se)...)
}

// negotiate answers one option command. Each option is answered once per change of state, so two sides
// that both ask cannot loop.
func (s *Shell) negotiate(cmd, opt byte) {
	s.state.Lock()
	defer s.state.Unlock()
	switch cmd {
	case will: // the server offers to do something
		if opt == optEcho || opt == optSGA {
			if !s.him[opt] {
				s.him[opt] = true
				s.sendLocked(iac, do, opt)
			}
		} else {
			s.sendLocked(iac, dont, opt)
		}
	case wont:
		if s.him[opt] {
			delete(s.him, opt)
			s.sendLocked(iac, dont, opt)
		}
	case do: // the server asks us to do something
		if opt == optNAWS || opt == optTType {
			if !s.us[opt] {
				s.us[opt] = true
				s.sendLocked(iac, will, opt)
				if opt == optNAWS {
					go s.naws()
				}
			}
		} else {
			s.sendLocked(iac, wont, opt)
		}
	case dont:
		if s.us[opt] {
			delete(s.us, opt)
			s.sendLocked(iac, wont, opt)
		}
	}
}

func (s *Shell) sendLocked(b ...byte) {
	// called with s.state held: write without taking it again
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, _ = s.conn.Write(b)
}

func (s *Shell) subnegotiation(body []byte) {
	if len(body) >= 2 && body[0] == optTType && body[1] == ttypeSend {
		msg := append([]byte{iac, sb, optTType, ttypeIs}, []byte("xterm-256color")...)
		s.send(append(msg, iac, se)...)
	}
}

// autoLogin types the user name and the password at the first login and password prompts only.
func (s *Shell) autoLogin(text string) {
	if s.user == "" && s.pass == "" {
		return
	}
	if time.Since(s.start) > autoLoginWindow || (s.sentUser || s.user == "") && (s.sentPass || s.pass == "") {
		return
	}
	s.tail += strings.ReplaceAll(strings.ReplaceAll(text, "\r", ""), "\x00", "")
	if len(s.tail) > 200 {
		s.tail = s.tail[len(s.tail)-200:]
	}
	line := s.tail
	if i := strings.LastIndexByte(line, '\n'); i >= 0 && i < len(line)-1 {
		line = line[i+1:]
	}
	switch {
	case s.user != "" && !s.sentUser && userPrompt.MatchString(line):
		s.sentUser = true
		s.tail = ""
		s.send([]byte(s.user + "\r\n")...)
	case s.pass != "" && !s.sentPass && (s.sentUser || s.user == "") && passPrompt.MatchString(line):
		s.sentPass = true
		s.tail = ""
		s.send([]byte(s.pass + "\r\n")...)
	}
}

func (s *Shell) read(onData func([]byte)) {
	defer close(s.done)
	buf := make([]byte, 16*1024)
	var sub []byte
	const (
		data = iota
		gotIAC
		gotCmd
		inSB
		sbIAC
	)
	st, cmd := data, byte(0)
	for {
		n, err := s.conn.Read(buf)
		var out []byte
		for _, b := range buf[:n] {
			switch st {
			case data:
				if b == iac {
					st = gotIAC
				} else {
					out = append(out, b)
				}
			case gotIAC:
				switch b {
				case iac:
					out = append(out, iac)
					st = data
				case will, wont, do, dont:
					cmd, st = b, gotCmd
				case sb:
					sub, st = nil, inSB
				default: // NOP, GA, and the like
					st = data
				}
			case gotCmd:
				s.negotiate(cmd, b)
				st = data
			case inSB:
				if b == iac {
					st = sbIAC
				} else {
					sub = append(sub, b)
				}
			case sbIAC:
				switch b {
				case se:
					s.subnegotiation(sub)
					st = data
				case iac:
					sub = append(sub, iac)
					st = inSB
				default:
					st = inSB
				}
			}
		}
		if len(out) > 0 {
			onData(out)
			s.autoLogin(string(out))
		}
		if err != nil {
			s.err = err
			return
		}
	}
}

// Write sends keystrokes. A byte of 255 is doubled, and Enter ("\r") becomes the network's "\r\n".
func (s *Shell) Write(p []byte) (int, error) {
	q := bytes.ReplaceAll(p, []byte("\r\n"), []byte("\r"))
	q = bytes.ReplaceAll(q, []byte("\r"), []byte("\r\n"))
	q = bytes.ReplaceAll(q, []byte{iac}, []byte{iac, iac})
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if _, err := s.conn.Write(q); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Resize tells the server the new window size, when it asked for it.
func (s *Shell) Resize(cols, rows int) error {
	s.state.Lock()
	s.cols, s.rows = cols, rows
	on := s.us[optNAWS]
	s.state.Unlock()
	if on {
		s.naws()
	}
	return nil
}

func (s *Shell) Done() <-chan struct{} { return s.done }

// Err is nil when the server logged us out or we closed the connection, and the network error otherwise.
func (s *Shell) Err() error {
	<-s.done
	if s.closedByUs.Load() || s.err == nil || errors.Is(s.err, io.EOF) || errors.Is(s.err, net.ErrClosed) {
		return nil
	}
	return s.err
}

// Close ends the connection.
func (s *Shell) Close() {
	s.once.Do(func() {
		s.closedByUs.Store(true)
		_ = s.conn.Close()
	})
}
