package usecase

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"vvterm/internal/domain"
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

func isDeviceID(id string) bool {
	return id == LocalHostID || strings.HasPrefix(id, serialPrefix) || strings.HasPrefix(id, telnetPrefix)
}

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

const telnetPrefix = "telnet:"

// TelnetID is the session host id that opens a saved host over Telnet instead of SSH.
func TelnetID(hostID string) string { return telnetPrefix + hostID }

// telnetCredentials returns the address and what to type at the login prompt: the host's user name (or
// the identity's) and the identity's password, when it is a password identity. Keys and agents do not
// exist in Telnet, so those identities give no password.
func (c *Core) telnetCredentials(h domain.Host) (addr, user, pass string, err error) {
	if !h.TelnetEnabled {
		return "", "", "", fmt.Errorf("Telnet is not enabled for %q: edit the host and turn it on", h.Label)
	}
	user = h.TelnetUsername
	if user == "" {
		user = h.Username
	}
	// a password saved for Telnet wins over the one of the host's identity
	if pw, gerr := c.Vault.GetSecret(domain.TelnetSecretRef(h.ID)); gerr == nil {
		pass = string(pw)
	} else if h.IdentityID != "" {
		id, ierr := c.Store.GetIdentity(h.IdentityID)
		if ierr != nil {
			return "", "", "", fmt.Errorf("identity of %q: %w", h.Label, ierr)
		}
		if user == "" {
			user = id.Username
		}
		if id.AuthType == domain.AuthPassword {
			pw, gerr := c.Vault.GetSecret(id.SecretRef)
			if gerr != nil {
				return "", "", "", vaultErr(gerr)
			}
			pass = string(pw)
		}
	}
	return net.JoinHostPort(h.Hostname, strconv.Itoa(h.TelnetPort)), user, pass, nil
}
