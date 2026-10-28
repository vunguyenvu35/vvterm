package usecase

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Special host ids understood by SessionService.Open: a shell on this computer, or a serial port.
const (
	LocalHostID  = "local"
	serialPrefix = "serial:"
)

var serialDevice = regexp.MustCompile(`^(/dev/[A-Za-z0-9._-]+|COM[0-9]+)$`)

// SerialID builds the session host id of a serial port: "serial:/dev/cu.usbserial-1410@115200".
func SerialID(path string, baud int) string { return fmt.Sprintf("%s%s@%d", serialPrefix, path, baud) }

// ParseSerialID is the inverse of SerialID and validates both halves.
func ParseSerialID(id string) (path string, baud int, err error) {
	rest, ok := strings.CutPrefix(id, serialPrefix)
	if !ok {
		return "", 0, fmt.Errorf("%q is not a serial port", id)
	}
	i := strings.LastIndex(rest, "@")
	if i < 0 {
		return "", 0, fmt.Errorf("serial port %q has no baud rate", rest)
	}
	path = rest[:i]
	if !serialDevice.MatchString(path) {
		return "", 0, fmt.Errorf("%q is not a serial device", path)
	}
	baud, err = strconv.Atoi(rest[i+1:])
	if err != nil || baud < 50 || baud > 4_000_000 {
		return "", 0, fmt.Errorf("baud rate %q is out of range", rest[i+1:])
	}
	return path, baud, nil
}

func isDeviceID(id string) bool { return id == LocalHostID || strings.HasPrefix(id, serialPrefix) }

// SerialService lists serial ports for the Serial panel.
type SerialService struct{ c *Core }

func NewSerialService(c *Core) *SerialService { return &SerialService{c: c} }

// Ports returns the serial devices found on this computer (an empty list, never null).
func (s *SerialService) Ports() ([]string, error) {
	if s.c.ListSerial == nil {
		return []string{}, nil
	}
	p, err := s.c.ListSerial()
	if p == nil {
		p = []string{}
	}
	return p, err
}
