package serialx

import (
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

func TestOpenRefusesNonDevicesAndBadSpeeds(t *testing.T) {
	for _, p := range []string{"", "relative", "../etc/passwd", "/etc/passwd", "/dev/../etc/passwd", "/dev/a b", "/tmp/x"} {
		if _, err := Open(p, 9600, func([]byte) {}); err == nil || !strings.Contains(err.Error(), "not a serial device") {
			t.Errorf("Open(%q) = %v, want a refusal", p, err)
		}
	}
	for _, b := range []int{0, 49, 5_000_000} {
		if _, err := Open("/dev/null", b, func([]byte) {}); err == nil || !strings.Contains(err.Error(), "baud") {
			t.Errorf("baud %d: %v", b, err)
		}
	}
}

func TestPortsReturnsASortedList(t *testing.T) {
	ports, err := Ports()
	if err != nil {
		t.Skipf("no serial support here: %v", err)
	}
	for i := 1; i < len(ports); i++ {
		if ports[i-1] > ports[i] {
			t.Fatalf("not sorted: %v", ports)
		}
	}
}

// A pseudo-terminal pair stands in for a device: what one end writes, the other reads.
func TestReadsAndWritesThroughADevice(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Skipf("no pty: %v", err)
	}
	defer master.Close()
	defer slave.Close()
	got := make(chan string, 8)
	sh, err := Open(slave.Name(), 115200, func(p []byte) { got <- string(p) })
	if err != nil {
		t.Skipf("this system cannot open a pty as a serial port: %v", err)
	}
	if _, err := master.Write([]byte("hello\r\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-got:
		if !strings.Contains(s, "hello") {
			t.Fatalf("got %q", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing arrived")
	}
	if err := sh.Resize(80, 24); err != nil {
		t.Fatal("resize is a no-op, never an error")
	}
	sh.Close()
	select {
	case <-sh.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Close must end the session")
	}
	if err := sh.Err(); err != nil {
		t.Fatalf("closing the port ourselves is a normal end: %v", err)
	}
	sh.Close() // idempotent
}
