// Package serialx talks to serial ports (USB adapters, routers, embedded boards). It implements the
// usecase.Shell port, so a serial port opens in a terminal tab like any other session.
package serialx

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"go.bug.st/serial"
)

// Shell is an open serial port.
type Shell struct {
	port serial.Port
	done chan struct{}
	err  error
	once sync.Once

	closedByUs atomic.Bool
}

// devicePath keeps Open to device files: no relative paths, no other directories.
var devicePath = regexp.MustCompile(`^(/dev/[A-Za-z0-9._-]+|COM[0-9]+)$`)

// Ports lists the serial ports of this computer. On macOS every device appears twice (tty.* waits for a
// carrier, cu.* does not); only the cu.* ones are useful for a terminal, so those are preferred.
func Ports() ([]string, error) {
	all, err := serial.GetPortsList()
	if err != nil {
		return nil, err
	}
	var cu, other []string
	for _, p := range all {
		switch {
		case strings.HasPrefix(p, "/dev/cu."):
			cu = append(cu, p)
		case strings.HasPrefix(p, "/dev/tty."):
			if !strings.Contains(p, "Bluetooth-Incoming") {
				other = append(other, p)
			}
		default:
			other = append(other, p)
		}
	}
	out := cu
	if len(cu) == 0 {
		out = other
	}
	sort.Strings(out)
	return out, nil
}

// Open opens a port at the given speed (8 data bits, no parity, 1 stop bit: what almost every device uses).
func Open(path string, baud int, onData func([]byte)) (*Shell, error) {
	if !devicePath.MatchString(path) {
		return nil, fmt.Errorf("%q is not a serial device", path)
	}
	if baud < 50 || baud > 4_000_000 {
		return nil, errors.New("baud rate out of range")
	}
	p, err := serial.Open(path, &serial.Mode{BaudRate: baud, DataBits: 8, Parity: serial.NoParity, StopBits: serial.OneStopBit})
	if err != nil {
		return nil, err
	}
	s := &Shell{port: p, done: make(chan struct{})}
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				onData(append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				s.err = err
				break
			}
			if n == 0 { // closed
				break
			}
		}
		close(s.done)
	}()
	return s, nil
}

func (s *Shell) Write(p []byte) (int, error) { return s.port.Write(p) }

// Resize does nothing: a serial line has no window size.
func (s *Shell) Resize(cols, rows int) error { return nil }

func (s *Shell) Done() <-chan struct{} { return s.done }

// Err is nil after the user closed the port, and the read error when the device was unplugged.
func (s *Shell) Err() error {
	<-s.done
	if s.closedByUs.Load() {
		return nil
	}
	return s.err
}

// Close closes the port.
func (s *Shell) Close() {
	s.once.Do(func() {
		s.closedByUs.Store(true)
		_ = s.port.Close()
	})
}
