package forward

import (
	"bufio"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/domain"
	"vvterm/internal/sshx"
	"vvterm/internal/testssh"
)

type env struct {
	srv    *testssh.Server
	client *sshx.Client
}

func setup(t *testing.T) *env {
	t.Helper()
	srv, err := testssh.Start(testssh.Config{User: "u", Password: "p"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	d := &sshx.Dialer{HostKeys: &sshx.HostKeyChecker{Path: t.TempDir() + "/kh",
		Prompt: func(string, ssh.PublicKey) (bool, error) { return true, nil }}, Timeout: 5 * time.Second}
	c, err := d.Dial([]sshx.Hop{{Label: "t", Hostname: "127.0.0.1", Port: srv.Port(), Username: "u", Auth: sshx.PasswordAuth("p")}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return &env{srv, c}
}

// echoServer replies "<prefix>:<line>\n" for each line it receives.
func echoServer(t *testing.T, prefix string) (addr string, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				for {
					l, err := r.ReadString('\n')
					if err != nil {
						return
					}
					c.Write([]byte(prefix + ":" + l))
				}
			}()
		}
	}()
	p := ln.Addr().(*net.TCPAddr).Port
	return ln.Addr().String(), p
}

func roundTrip(t *testing.T, addr, msg string) string {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Write([]byte(msg + "\n")); err != nil {
		t.Fatal(err)
	}
	l, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return l
}

func TestLocalForward(t *testing.T) {
	e := setup(t)
	_, dport := echoServer(t, "db")
	f, err := Start(e.client, domain.PortForward{Type: domain.ForwardLocal, BindAddr: "127.0.0.1", DestHost: "127.0.0.1", DestPort: dport})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	if got := roundTrip(t, f.Addr, "ping"); got != "db:ping\n" {
		t.Fatalf("got %q", got)
	}
	// several sequential and concurrent connections
	done := make(chan string, 5)
	for i := 0; i < 5; i++ {
		go func(i int) { done <- roundTrip(t, f.Addr, "m"+strconv.Itoa(i)) }(i)
	}
	for i := 0; i < 5; i++ {
		if g := <-done; len(g) < 4 || g[:3] != "db:" {
			t.Fatalf("bad reply %q", g)
		}
	}
}

func TestLocalForwardToClosedDestinationClosesClient(t *testing.T) {
	e := setup(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	f, err := Start(e.client, domain.PortForward{Type: domain.ForwardLocal, BindAddr: "127.0.0.1", DestHost: "127.0.0.1", DestPort: dead})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	c, _ := net.Dial("tcp", f.Addr)
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("expected EOF, got %v", err)
	}
}

func TestStopClosesListenerAndLiveConnections(t *testing.T) {
	e := setup(t)
	_, dport := echoServer(t, "x")
	f, _ := Start(e.client, domain.PortForward{Type: domain.ForwardLocal, BindAddr: "127.0.0.1", DestHost: "127.0.0.1", DestPort: dport})
	live, err := net.Dial("tcp", f.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	live.Write([]byte("a\n"))
	bufio.NewReader(live).ReadString('\n')

	stopped := make(chan struct{})
	go func() { f.Stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop hung with a live connection")
	}
	live.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := live.Read(make([]byte, 1)); err == nil {
		t.Fatal("live connection survived Stop")
	}
	if _, err := net.DialTimeout("tcp", f.Addr, 300*time.Millisecond); err == nil {
		t.Fatal("listener still accepting after Stop")
	}
	f.Stop() // idempotent
	select {
	case <-f.Done():
	default:
		t.Fatal("Done not closed")
	}
}

func TestRemoteForward(t *testing.T) {
	e := setup(t)
	_, dport := echoServer(t, "local")
	f, err := Start(e.client, domain.PortForward{Type: domain.ForwardRemote, BindAddr: "127.0.0.1", BindPort: 0, DestHost: "127.0.0.1", DestPort: dport})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	if got := roundTrip(t, f.Addr, "webhook"); got != "local:webhook\n" {
		t.Fatalf("got %q", got)
	}
}

func TestPublicBindRefusedWithoutOptIn(t *testing.T) {
	e := setup(t)
	for _, typ := range []domain.ForwardType{domain.ForwardLocal, domain.ForwardDynamic} {
		if _, err := Start(e.client, domain.PortForward{Type: typ, BindAddr: "0.0.0.0", DestHost: "x", DestPort: 1}); err == nil {
			t.Fatalf("%s: bound 0.0.0.0 without opt-in", typ)
		}
	}
	f, err := Start(e.client, domain.PortForward{Type: domain.ForwardDynamic, BindAddr: "0.0.0.0", AllowPublicBind: true})
	if err != nil {
		t.Fatalf("opt-in refused: %v", err)
	}
	f.Stop()
}

func TestPortInUseReportsError(t *testing.T) {
	e := setup(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	_, err := Start(e.client, domain.PortForward{Type: domain.ForwardDynamic, BindAddr: "127.0.0.1", BindPort: ln.Addr().(*net.TCPAddr).Port})
	if err == nil {
		t.Fatal("expected bind error")
	}
}

// ---- SOCKS5 ----

func socksConnect(t *testing.T, proxy string, atyp byte, host string, port int) (net.Conn, byte) {
	t.Helper()
	c, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(3 * time.Second))
	c.Write([]byte{5, 1, 0})
	r := make([]byte, 2)
	io.ReadFull(c, r)
	if r[0] != 5 || r[1] != 0 {
		t.Fatalf("method reply %v", r)
	}
	req := []byte{5, 1, 0, atyp}
	switch atyp {
	case 1:
		req = append(req, net.ParseIP(host).To4()...)
	case 3:
		req = append(req, byte(len(host)))
		req = append(req, host...)
	case 4:
		req = append(req, net.ParseIP(host).To16()...)
	}
	req = append(req, byte(port>>8), byte(port))
	c.Write(req)
	rep := make([]byte, 10)
	if _, err := io.ReadFull(c, rep); err != nil {
		t.Fatalf("reply: %v", err)
	}
	return c, rep[1]
}

func TestSocks5Connect(t *testing.T) {
	e := setup(t)
	_, dport := echoServer(t, "intranet")
	f, err := Start(e.client, domain.PortForward{Type: domain.ForwardDynamic, BindAddr: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	for _, tc := range []struct {
		name string
		atyp byte
		host string
	}{{"ipv4", 1, "127.0.0.1"}, {"domain", 3, "localhost"}} {
		t.Run(tc.name, func(t *testing.T) {
			c, code := socksConnect(t, f.Addr, tc.atyp, tc.host, dport)
			defer c.Close()
			if code != 0 {
				t.Fatalf("reply code %d", code)
			}
			c.Write([]byte("hi\n"))
			l, _ := bufio.NewReader(c).ReadString('\n')
			if l != "intranet:hi\n" {
				t.Fatalf("got %q", l)
			}
		})
	}
}

func TestSocks5FailureCodes(t *testing.T) {
	e := setup(t)
	f, _ := Start(e.client, domain.PortForward{Type: domain.ForwardDynamic, BindAddr: "127.0.0.1"})
	defer f.Stop()

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	c, code := socksConnect(t, f.Addr, 1, "127.0.0.1", dead)
	c.Close()
	if code == 0 {
		t.Fatal("connect to dead port reported success")
	}

	// BIND command unsupported
	raw, _ := net.Dial("tcp", f.Addr)
	defer raw.Close()
	raw.SetDeadline(time.Now().Add(2 * time.Second))
	raw.Write([]byte{5, 1, 0})
	io.ReadFull(raw, make([]byte, 2))
	raw.Write([]byte{5, 2, 0, 1, 127, 0, 0, 1, 0, 80})
	rep := make([]byte, 10)
	io.ReadFull(raw, rep)
	if rep[1] != repCmdUnsupp {
		t.Fatalf("BIND got code %d", rep[1])
	}
}

func TestSocks5RejectsWrongVersionAndAuthOnly(t *testing.T) {
	e := setup(t)
	f, _ := Start(e.client, domain.PortForward{Type: domain.ForwardDynamic, BindAddr: "127.0.0.1"})
	defer f.Stop()

	c, _ := net.Dial("tcp", f.Addr)
	c.SetDeadline(time.Now().Add(2 * time.Second))
	c.Write([]byte{4, 1, 0})
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("SOCKS4 accepted")
	}
	c.Close()

	c, _ = net.Dial("tcp", f.Addr)
	defer c.Close()
	c.SetDeadline(time.Now().Add(2 * time.Second))
	c.Write([]byte{5, 1, 2}) // only user/pass offered
	r := make([]byte, 2)
	io.ReadFull(c, r)
	if r[1] != 0xff {
		t.Fatalf("expected no-acceptable-methods, got %v", r)
	}
}
