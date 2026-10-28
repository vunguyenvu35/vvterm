package forward

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// SOCKS5 reply codes (RFC 1928).
const (
	repOK          = 0x00
	repFailure     = 0x01
	repHostUnreach = 0x04
	repRefused     = 0x05
	repCmdUnsupp   = 0x07
	repAtypUnsupp  = 0x08
)

// socks serves one SOCKS5 client: no authentication, CONNECT only.
func (f *Forward) socks(c Dialer, in net.Conn) {
	in.SetDeadline(time.Now().Add(15 * time.Second))
	host, port, err := socksHandshake(in)
	if err != nil {
		return
	}
	dst, err := c.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		code := byte(repFailure)
		if errors.Is(err, io.EOF) {
			code = repHostUnreach
		}
		socksReply(in, code)
		return
	}
	if !f.track(dst) {
		dst.Close()
		return
	}
	defer f.untrack(dst)
	if err := socksReply(in, repOK); err != nil {
		return
	}
	in.SetDeadline(time.Time{})
	Pipe(in, dst)
}

func socksHandshake(c net.Conn) (host string, port int, err error) {
	hdr := make([]byte, 2)
	if _, err = io.ReadFull(c, hdr); err != nil {
		return
	}
	if hdr[0] != 5 {
		return "", 0, fmt.Errorf("not SOCKS5 (version %d)", hdr[0])
	}
	methods := make([]byte, hdr[1])
	if _, err = io.ReadFull(c, methods); err != nil {
		return
	}
	noAuth := false
	for _, m := range methods {
		if m == 0 {
			noAuth = true
		}
	}
	if !noAuth {
		c.Write([]byte{5, 0xff})
		return "", 0, errors.New("no acceptable auth method")
	}
	if _, err = c.Write([]byte{5, 0}); err != nil {
		return
	}
	req := make([]byte, 4)
	if _, err = io.ReadFull(c, req); err != nil {
		return
	}
	if req[1] != 1 {
		socksReply(c, repCmdUnsupp)
		return "", 0, errors.New("only CONNECT is supported")
	}
	switch req[3] {
	case 1:
		b := make([]byte, 4)
		if _, err = io.ReadFull(c, b); err != nil {
			return
		}
		host = net.IP(b).String()
	case 4:
		b := make([]byte, 16)
		if _, err = io.ReadFull(c, b); err != nil {
			return
		}
		host = net.IP(b).String()
	case 3:
		l := make([]byte, 1)
		if _, err = io.ReadFull(c, l); err != nil {
			return
		}
		b := make([]byte, l[0])
		if _, err = io.ReadFull(c, b); err != nil {
			return
		}
		host = string(b)
	default:
		socksReply(c, repAtypUnsupp)
		return "", 0, errors.New("unsupported address type")
	}
	p := make([]byte, 2)
	if _, err = io.ReadFull(c, p); err != nil {
		return
	}
	return host, int(p[0])<<8 | int(p[1]), nil
}

func socksReply(c net.Conn, code byte) error {
	_, err := c.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
	return err
}
