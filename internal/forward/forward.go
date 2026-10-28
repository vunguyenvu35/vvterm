// Package forward implements SSH port forwarding: local (-L), remote (-R) and
// dynamic (-D, SOCKS5).
package forward

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/domain"
)

// Dialer is the part of *ssh.Client the forwarders need.
type Dialer interface {
	Dial(network, addr string) (net.Conn, error)
	Listen(network, addr string) (net.Listener, error)
}

var _ Dialer = (*ssh.Client)(nil)

// Forward is a running forward.
type Forward struct {
	Spec domain.PortForward
	// Addr is the real bound address (useful when BindPort was 0).
	Addr string

	ln   net.Listener
	mu   sync.Mutex
	open map[net.Conn]struct{}
	done chan struct{}
	wg   sync.WaitGroup
	once sync.Once
}

// Start binds according to spec and begins serving. It returns once listening.
func Start(c Dialer, spec domain.PortForward) (*Forward, error) {
	f := &Forward{Spec: spec, open: map[net.Conn]struct{}{}, done: make(chan struct{})}
	bind := net.JoinHostPort(spec.BindAddr, strconv.Itoa(spec.BindPort))
	var err error
	switch spec.Type {
	case domain.ForwardLocal, domain.ForwardDynamic:
		if !spec.AllowPublicBind && !isLoopback(spec.BindAddr) {
			return nil, fmt.Errorf("refusing to bind %s without allow_public_bind", spec.BindAddr)
		}
		f.ln, err = net.Listen("tcp", bind)
	case domain.ForwardRemote:
		f.ln, err = c.Listen("tcp", bind)
	default:
		return nil, fmt.Errorf("unknown forward type %q", spec.Type)
	}
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", bind, err)
	}
	f.Addr = f.ln.Addr().String()
	f.wg.Add(1)
	go f.serve(c)
	return f, nil
}

func isLoopback(a string) bool {
	if a == "" || a == "localhost" {
		return true
	}
	ip := net.ParseIP(a)
	return ip != nil && ip.IsLoopback()
}

func (f *Forward) serve(c Dialer) {
	defer f.wg.Done()
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		if !f.track(conn) {
			conn.Close()
			return
		}
		f.wg.Add(1)
		go func() {
			defer f.wg.Done()
			defer f.untrack(conn)
			switch f.Spec.Type {
			case domain.ForwardLocal:
				f.local(c, conn)
			case domain.ForwardRemote:
				f.remote(conn)
			case domain.ForwardDynamic:
				f.socks(c, conn)
			}
		}()
	}
}

func (f *Forward) track(c net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.done:
		return false
	default:
	}
	f.open[c] = struct{}{}
	return true
}

func (f *Forward) untrack(c net.Conn) {
	c.Close()
	f.mu.Lock()
	delete(f.open, c)
	f.mu.Unlock()
}

func (f *Forward) local(c Dialer, in net.Conn) {
	dst, err := c.Dial("tcp", net.JoinHostPort(f.Spec.DestHost, strconv.Itoa(f.Spec.DestPort)))
	if err != nil {
		return
	}
	if !f.track(dst) {
		dst.Close()
		return
	}
	defer f.untrack(dst)
	Pipe(in, dst)
}

func (f *Forward) remote(in net.Conn) {
	dst, err := net.Dial("tcp", net.JoinHostPort(f.Spec.DestHost, strconv.Itoa(f.Spec.DestPort)))
	if err != nil {
		return
	}
	if !f.track(dst) {
		dst.Close()
		return
	}
	defer f.untrack(dst)
	Pipe(in, dst)
}

// Stop closes the listener and every live connection, and waits for goroutines.
func (f *Forward) Stop() {
	f.once.Do(func() {
		close(f.done)
		f.ln.Close()
		f.mu.Lock()
		for c := range f.open {
			c.Close()
		}
		f.mu.Unlock()
	})
	f.wg.Wait()
}

// Done is closed after Stop.
func (f *Forward) Done() <-chan struct{} { return f.done }

// Pipe copies both directions and returns when either side ends.
func Pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	// half-close finished one direction; give the other a chance to drain by closing both
	a.Close()
	b.Close()
	<-done
}

var ErrUnsupported = errors.New("unsupported")
