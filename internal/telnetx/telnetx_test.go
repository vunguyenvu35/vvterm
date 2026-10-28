package telnetx

import (
	"bytes"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// server is a scripted Telnet server: tests drive what it sends and read what the client answered.
type server struct {
	ln   net.Listener
	conn chan net.Conn
}

func startServer(t *testing.T) *server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &server{ln: ln, conn: make(chan net.Conn, 1)}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err == nil {
			s.conn <- c
		}
	}()
	return s
}

func (s *server) accept(t *testing.T) net.Conn {
	t.Helper()
	select {
	case c := <-s.conn:
		t.Cleanup(func() { c.Close() })
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("the client never connected")
		return nil
	}
}

type out struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (o *out) write(p []byte) { o.mu.Lock(); o.buf.Write(p); o.mu.Unlock() }
func (o *out) text() string   { o.mu.Lock(); defer o.mu.Unlock(); return o.buf.String() }
func (o *out) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(o.text(), want) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("never saw %q in %q", want, o.text())
}

// readUntil reads what the client sent until it has at least n bytes or the timeout passes.
func readN(t *testing.T, c net.Conn, n int) []byte {
	t.Helper()
	got := make([]byte, 0, n)
	buf := make([]byte, 256)
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for len(got) < n {
		m, err := c.Read(buf)
		got = append(got, buf[:m]...)
		if err != nil {
			t.Fatalf("read: %v (got %q)", err, got)
		}
	}
	return got
}

func open(t *testing.T, s *server, user, pass string) (*Shell, *out, net.Conn) {
	t.Helper()
	o := &out{}
	sh, err := Open(s.ln.Addr().String(), 2*time.Second, 100, 30, user, pass, o.write)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sh.Close)
	return sh, o, s.accept(t)
}

func TestNegotiationAcceptsEchoAndSGAAndRefusesTheRest(t *testing.T) {
	s := startServer(t)
	_, _, c := open(t, s, "", "")
	c.Write([]byte{iac, will, optEcho, iac, will, optSGA, iac, will, 99, iac, do, 77})
	got := readN(t, c, 12)
	want := []byte{iac, do, optEcho, iac, do, optSGA, iac, dont, 99, iac, wont, 77}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestAnOptionIsAnsweredOnceSoNegotiationCannotLoop(t *testing.T) {
	s := startServer(t)
	_, o, c := open(t, s, "", "")
	c.Write([]byte{iac, will, optEcho, iac, will, optEcho, iac, will, optEcho})
	c.Write([]byte("ping"))
	o.waitFor(t, "") // the read loop is running
	got := readN(t, c, 3)
	if !bytes.Equal(got, []byte{iac, do, optEcho}) {
		t.Fatalf("%v", got)
	}
	c.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if n, _ := c.Read(make([]byte, 16)); n != 0 {
		t.Fatalf("a repeated offer must not be answered again (%d extra bytes)", n)
	}
}

func TestWindowSizeAndTerminalTypeAreReported(t *testing.T) {
	s := startServer(t)
	sh, _, c := open(t, s, "", "")
	c.Write([]byte{iac, do, optNAWS, iac, do, optTType})
	got := readN(t, c, 6+9)
	want := append([]byte{iac, will, optNAWS, iac, will, optTType}, []byte{iac, sb, optNAWS, 0, 100, 0, 30, iac, se}...)
	// the WILLs, then the size (the order of the two WILLs and the size is fixed by the client)
	if !bytes.Contains(got, []byte{iac, sb, optNAWS, 0, 100, 0, 30, iac, se}) || !bytes.HasPrefix(got, []byte{iac, will, optNAWS}) {
		t.Fatalf("got %v want something like %v", got, want)
	}
	c.Write([]byte{iac, sb, optTType, ttypeSend, iac, se})
	reply := readN(t, c, 4+14+2)
	if !bytes.Contains(reply, append([]byte{iac, sb, optTType, ttypeIs}, []byte("xterm-256color")...)) {
		t.Fatalf("%q", reply)
	}
	if err := sh.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, c, 9); !bytes.Equal(got, []byte{iac, sb, optNAWS, 0, 120, 0, 40, iac, se}) {
		t.Fatalf("a new size is announced: %v", got)
	}
}

func TestWindowSizeWithA255IsEscaped(t *testing.T) {
	s := startServer(t)
	sh, _, c := open(t, s, "", "")
	c.Write([]byte{iac, do, optNAWS})
	readN(t, c, 3+9)
	if err := sh.Resize(255, 40); err != nil {
		t.Fatal(err)
	}
	want := []byte{iac, sb, optNAWS, 0, iac, iac, 0, 40, iac, se}
	if got := readN(t, c, len(want)); !bytes.Equal(got, want) {
		t.Fatalf("a 255 inside a subnegotiation is doubled: %v", got)
	}
}

func TestDataPassesThroughWithoutNegotiationBytes(t *testing.T) {
	s := startServer(t)
	_, o, c := open(t, s, "", "")
	c.Write(append(append([]byte("hel"), iac, will, optEcho), append([]byte("lo "), iac, iac, 'x', iac, 241 /* NOP */, '!')...))
	o.waitFor(t, "hello \xffx!")
}

func TestKeystrokesAreEscapedAndEnterBecomesCRLF(t *testing.T) {
	s := startServer(t)
	sh, _, c := open(t, s, "", "")
	sh.Write([]byte("ls\r"))
	if got := readN(t, c, 4); string(got) != "ls\r\n" {
		t.Fatalf("%q", got)
	}
	sh.Write([]byte("a\r\nb"))
	if got := readN(t, c, 4); string(got) != "a\r\nb" {
		t.Fatalf("an existing CRLF is not doubled: %q", got)
	}
	sh.Write([]byte{'x', 0xff, 'y'})
	if got := readN(t, c, 4); !bytes.Equal(got, []byte{'x', iac, iac, 'y'}) {
		t.Fatalf("%v", got)
	}
}

func TestAutoLoginTypesUserAndPasswordAtTheirPromptsOnce(t *testing.T) {
	s := startServer(t)
	_, o, c := open(t, s, "alice", "s3cret")
	c.Write([]byte("Welcome to the switch\r\nlogin: "))
	if got := readN(t, c, len("alice\r\n")); string(got) != "alice\r\n" {
		t.Fatalf("%q", got)
	}
	c.Write([]byte("Password: "))
	if got := readN(t, c, len("s3cret\r\n")); string(got) != "s3cret\r\n" {
		t.Fatalf("%q", got)
	}
	c.Write([]byte("\r\nswitch# "))
	o.waitFor(t, "switch# ")
	// a later prompt of any kind is never answered with the stored password
	c.Write([]byte("[sudo] password for alice: login: Password: "))
	c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if n, _ := c.Read(make([]byte, 64)); n != 0 {
		t.Fatalf("the stored password must be sent at most once (%d bytes)", n)
	}
}

func TestPasswordIsNotSentBeforeTheUserNameWasAccepted(t *testing.T) {
	s := startServer(t)
	_, _, c := open(t, s, "alice", "s3cret")
	c.Write([]byte("Password: "))
	c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if n, _ := c.Read(make([]byte, 64)); n != 0 {
		t.Fatalf("a password prompt before the login prompt is not ours to answer (%d bytes)", n)
	}
}

func TestAutoLoginOnlyInTheFirstSeconds(t *testing.T) {
	old := autoLoginWindow
	autoLoginWindow = 50 * time.Millisecond
	t.Cleanup(func() { autoLoginWindow = old })
	s := startServer(t)
	_, _, c := open(t, s, "alice", "s3cret")
	time.Sleep(120 * time.Millisecond)
	c.Write([]byte("login: "))
	c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if n, _ := c.Read(make([]byte, 64)); n != 0 {
		t.Fatalf("too late to log in automatically (%d bytes)", n)
	}
}

func TestNoCredentialsMeansTheUserTypesThem(t *testing.T) {
	s := startServer(t)
	_, _, c := open(t, s, "", "")
	c.Write([]byte("login: Password: "))
	c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if n, _ := c.Read(make([]byte, 64)); n != 0 {
		t.Fatalf("nothing is typed for the user (%d bytes)", n)
	}
}

func TestPasswordOnlyDevices(t *testing.T) {
	s := startServer(t)
	_, _, c := open(t, s, "", "s3cret") // many switches ask only for a password
	c.Write([]byte("Password: "))
	if got := readN(t, c, len("s3cret\r\n")); string(got) != "s3cret\r\n" {
		t.Fatalf("%q", got)
	}
}

func TestServerLogoutIsACleanEndAndCloseIsToo(t *testing.T) {
	s := startServer(t)
	sh, _, c := open(t, s, "", "")
	c.Close()
	select {
	case <-sh.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("must end when the server hangs up")
	}
	if err := sh.Err(); err != nil {
		t.Fatalf("a logout is not an error: %v", err)
	}
	s2 := startServer(t)
	sh2, _, _ := open(t, s2, "", "")
	sh2.Close()
	<-sh2.Done()
	if err := sh2.Err(); err != nil {
		t.Fatal(err)
	}
	sh2.Close() // idempotent
}

func TestConnectionRefusedIsReported(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	if _, err := Open(addr, time.Second, 80, 24, "", "", func([]byte) {}); err == nil {
		t.Fatal("expected an error")
	}
}
