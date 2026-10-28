package usecase

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"vvterm/internal/domain"
)

// fakeShell is an in-memory Shell: what is written comes back as "echo:<text>".
type fakeShell struct {
	mu      sync.Mutex
	onData  func([]byte)
	done    chan struct{}
	err     error
	once    sync.Once
	resizes [][2]int
	closed  bool
}

func newFakeShell(onData func([]byte)) *fakeShell {
	return &fakeShell{onData: onData, done: make(chan struct{})}
}
func (f *fakeShell) Write(p []byte) (int, error) {
	f.onData([]byte("echo:" + string(p)))
	return len(p), nil
}
func (f *fakeShell) Resize(c, r int) error {
	f.mu.Lock()
	f.resizes = append(f.resizes, [2]int{c, r})
	f.mu.Unlock()
	return nil
}
func (f *fakeShell) Done() <-chan struct{} { return f.done }
func (f *fakeShell) Err() error            { <-f.done; return f.err }
func (f *fakeShell) Close()                { f.mu.Lock(); f.closed = true; f.mu.Unlock(); f.end(nil) }
func (f *fakeShell) end(err error)         { f.once.Do(func() { f.err = err; close(f.done) }) }

type deviceFakes struct {
	mu     sync.Mutex
	shells []*fakeShell
	paths  []string
	bauds  []int
}

func (d *deviceFakes) install(h *harness) {
	open := func(onData func([]byte)) (Shell, error) {
		s := newFakeShell(onData)
		d.mu.Lock()
		d.shells = append(d.shells, s)
		d.mu.Unlock()
		return s, nil
	}
	h.app.Core.OpenLocalShell = func(cols, rows int, onData func([]byte)) (Shell, error) { return open(onData) }
	h.app.Core.OpenSerial = func(path string, baud int, onData func([]byte)) (Shell, error) {
		d.mu.Lock()
		d.paths, d.bauds = append(d.paths, path), append(d.bauds, baud)
		d.mu.Unlock()
		return open(onData)
	}
}
func (f *fakeShell) isClosed() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.closed }
func (f *fakeShell) resized() [][2]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][2]int(nil), f.resizes...)
}
func (d *deviceFakes) count() int { d.mu.Lock(); defer d.mu.Unlock(); return len(d.shells) }
func (d *deviceFakes) last() *fakeShell {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.shells[len(d.shells)-1]
}

func TestLocalTerminalSessionEndToEnd(t *testing.T) {
	h := newHarness(t).unlocked(t)
	var fk deviceFakes
	fk.install(h)
	sid, err := h.open(LocalHostID, 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	ready := h.rec.wait(t, "term:ready:"+sid)
	if ready.data.(map[string]any)["host"] != "This computer" {
		t.Fatalf("%+v", ready.data)
	}
	if err := h.app.Session.Write(sid, "ls\r"); err != nil {
		t.Fatal(err)
	}
	h.rec.waitOutput(t, sid, "echo:ls\r")
	if err := h.app.Session.Resize(sid, 120, 40); err != nil {
		t.Fatal(err)
	}
	if got := fk.last().resized(); len(got) != 1 || got[0] != [2]int{120, 40} {
		t.Fatalf("resizes %v", got)
	}
	fk.last().end(nil) // the user typed "exit"
	ev := h.rec.wait(t, "term:closed:"+sid)
	if m := ev.data.(map[string]any); m["reason"] != "session ended" || m["clean"] != true {
		t.Fatalf("%+v", m)
	}
	// Enter in the finished tab starts a fresh shell in the same tab
	if err := h.app.Session.Reconnect(sid, 80, 24); err != nil {
		t.Fatal(err)
	}
	h.rec.waitCount(t, "term:ready:"+sid, 2)
	if fk.count() != 2 {
		t.Fatalf("shells=%d", fk.count())
	}
	if err := h.app.Session.Close(sid); err != nil {
		t.Fatal(err)
	}
	if !fk.last().isClosed() {
		t.Fatal("closing the tab must close the shell")
	}
}

func TestDeviceSessionFailuresAreReportedInTheTab(t *testing.T) {
	h := newHarness(t).unlocked(t)
	// no adapters installed: "not available in this build"
	sid, err := h.open(LocalHostID, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	ev := h.rec.wait(t, "term:closed:"+sid)
	if r := ev.data.(map[string]any)["reason"].(string); !strings.Contains(r, "not available") {
		t.Fatal(r)
	}
	h.app.Core.OpenLocalShell = func(int, int, func([]byte)) (Shell, error) { return nil, errors.New("fork failed") }
	sid2, _ := h.open(LocalHostID, 80, 24)
	if r := h.rec.wait(t, "term:closed:"+sid2).data.(map[string]any)["reason"].(string); r != "fork failed" {
		t.Fatal(r)
	}
}

func TestDeviceLostIsAnErrorNotACleanEnd(t *testing.T) {
	h := newHarness(t).unlocked(t)
	var fk deviceFakes
	fk.install(h)
	sid, err := h.open(SerialID("/dev/cu.usbserial-1410", 115200), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	h.rec.wait(t, "term:ready:"+sid)
	fk.last().end(errors.New("device unplugged"))
	m := h.rec.wait(t, "term:closed:"+sid).data.(map[string]any)
	if m["clean"] != false || !strings.Contains(m["reason"].(string), "device unplugged") {
		t.Fatalf("%+v", m)
	}
}

func TestSerialSessionUsesThePortAndSpeedFromTheId(t *testing.T) {
	h := newHarness(t).unlocked(t)
	var fk deviceFakes
	fk.install(h)
	sid, err := h.open(SerialID("/dev/ttyUSB0", 9600), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if r := h.rec.wait(t, "term:ready:"+sid).data.(map[string]any)["host"]; r != "/dev/ttyUSB0" {
		t.Fatalf("%v", r)
	}
	fk.mu.Lock()
	defer fk.mu.Unlock()
	if fk.paths[0] != "/dev/ttyUSB0" || fk.bauds[0] != 9600 {
		t.Fatalf("%v %v", fk.paths, fk.bauds)
	}
}

func TestOpenRefusesBadSerialIdsAndUnknownHosts(t *testing.T) {
	h := newHarness(t).unlocked(t)
	for _, id := range []string{"serial:/etc/passwd@9600", "serial:/dev/ttyUSB0", "serial:/dev/ttyUSB0@fast", "serial:/dev/ttyUSB0@10", "serial:../x@9600", "nope"} {
		if _, err := h.app.Session.Open(id, 80, 24); err == nil {
			t.Errorf("Open(%q) must fail", id)
		}
	}
}

func TestSerialIDRoundTrip(t *testing.T) {
	id := SerialID("/dev/cu.usbmodem1101", 115200)
	p, b, err := ParseSerialID(id)
	if err != nil || p != "/dev/cu.usbmodem1101" || b != 115200 {
		t.Fatalf("%q %d %v", p, b, err)
	}
	if _, _, err := ParseSerialID("COM3@9600"); err == nil {
		t.Fatal("missing prefix")
	}
	if p, b, err := ParseSerialID("serial:COM3@9600"); err != nil || p != "COM3" || b != 9600 {
		t.Fatalf("%q %d %v", p, b, err)
	}
}

func TestSerialPortsNeverNull(t *testing.T) {
	h := newHarness(t).unlocked(t)
	if p, err := h.app.Serial.Ports(); err != nil || p == nil || len(p) != 0 {
		t.Fatalf("%v %v", p, err)
	}
	h.app.Core.ListSerial = func() ([]string, error) { return []string{"/dev/cu.a"}, nil }
	if p, _ := h.app.Serial.Ports(); len(p) != 1 {
		t.Fatalf("%v", p)
	}
	h.app.Core.ListSerial = func() ([]string, error) { return nil, nil }
	if p, _ := h.app.Serial.Ports(); p == nil {
		t.Fatal("a nil list becomes an empty one: Go sends null to the UI otherwise")
	}
}

// ---- Telnet ----

type telnetCall struct {
	addr, user, pass string
	cols, rows       int
}

func installTelnet(h *harness, calls *[]telnetCall, fk *deviceFakes) {
	h.app.Core.OpenTelnet = func(addr string, cols, rows int, user, pass string, onData func([]byte)) (Shell, error) {
		*calls = append(*calls, telnetCall{addr, user, pass, cols, rows})
		s := newFakeShell(onData)
		fk.mu.Lock()
		fk.shells = append(fk.shells, s)
		fk.mu.Unlock()
		return s, nil
	}
}

func telnetHost(t *testing.T, h *harness, over domain.Host) domain.Host {
	t.Helper()
	over.Label, over.Hostname = "switch", "10.0.0.2"
	saved, err := h.app.Host.SaveHost(over)
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestTelnetSessionUsesTheHostAndTheIdentityPassword(t *testing.T) {
	h := newHarness(t).unlocked(t)
	var calls []telnetCall
	var fk deviceFakes
	installTelnet(h, &calls, &fk)
	id, err := h.app.Vault.AddPassword("switch-login", "admin", "hunter2")
	if err != nil {
		t.Fatal(err)
	}
	host := telnetHost(t, h, domain.Host{TelnetEnabled: true, TelnetPort: 2323, IdentityID: id.ID})
	sid, err := h.open(TelnetID(host.ID), 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	if r := h.rec.wait(t, "term:ready:"+sid).data.(map[string]any)["host"]; r != "switch" {
		t.Fatalf("%v", r)
	}
	if len(calls) != 1 || calls[0] != (telnetCall{"10.0.0.2:2323", "admin", "hunter2", 100, 30}) {
		t.Fatalf("%+v", calls)
	}
	if e := h.waitLog(t, "Connected with Telnet (unencrypted) to switch"); !e.OK || e.HostLabel != "switch" {
		t.Fatalf("%+v", e)
	}
	for _, e := range h.logs(t, domain.ActivityFilter{}) {
		if strings.Contains(e.Message, "hunter2") {
			t.Fatal("the password must never reach the log")
		}
	}
	if err := h.app.Session.Write(sid, "show version\r"); err != nil {
		t.Fatal(err)
	}
	h.rec.waitOutput(t, sid, "echo:show version\r")
	fk.last().end(nil) // the device logged us out
	if m := h.rec.wait(t, "term:closed:"+sid).data.(map[string]any); m["clean"] != true {
		t.Fatalf("%+v", m)
	}
	if err := h.app.Session.Reconnect(sid, 80, 24); err != nil {
		t.Fatal(err)
	}
	h.rec.waitCount(t, "term:ready:"+sid, 2)
}

func TestTelnetNeedsTheHostToOptIn(t *testing.T) {
	h := newHarness(t).unlocked(t)
	var calls []telnetCall
	var fk deviceFakes
	installTelnet(h, &calls, &fk)
	host := telnetHost(t, h, domain.Host{})
	if _, err := h.app.Session.Open(TelnetID(host.ID), 80, 24); err == nil || !strings.Contains(err.Error(), "not enabled") {
		t.Fatalf("%v", err)
	}
	if _, err := h.app.Session.Open(TelnetID("missing"), 80, 24); err == nil {
		t.Fatal("unknown host")
	}
	if len(calls) != 0 {
		t.Fatal("nothing may be dialled")
	}
}

func TestTelnetWithoutPasswordIdentityTypesNoPassword(t *testing.T) {
	h := newHarness(t).unlocked(t)
	var calls []telnetCall
	var fk deviceFakes
	installTelnet(h, &calls, &fk)
	agent, err := h.app.Vault.AddAgent("agent", "fromidentity")
	if err != nil {
		t.Fatal(err)
	}
	host := telnetHost(t, h, domain.Host{TelnetEnabled: true, IdentityID: agent.ID})
	sid, _ := h.open(TelnetID(host.ID), 80, 24)
	h.rec.wait(t, "term:ready:"+sid)
	if len(calls) != 1 || calls[0].user != "fromidentity" || calls[0].pass != "" || calls[0].addr != "10.0.0.2:23" {
		t.Fatalf("keys and agents mean nothing to Telnet; the default port is 23: %+v", calls)
	}
	bare := telnetHost(t, h, domain.Host{TelnetEnabled: true, Username: "root"})
	sid2, _ := h.open(TelnetID(bare.ID), 80, 24)
	h.rec.wait(t, "term:ready:"+sid2)
	if calls[1].user != "root" || calls[1].pass != "" {
		t.Fatalf("%+v", calls[1])
	}
}

func TestTelnetFailuresAreShownInTheTab(t *testing.T) {
	h := newHarness(t).unlocked(t)
	id, _ := h.app.Vault.AddPassword("p", "u", "pw")
	host := telnetHost(t, h, domain.Host{TelnetEnabled: true, IdentityID: id.ID})
	sid, _ := h.open(TelnetID(host.ID), 80, 24) // no adapter installed
	if r := h.rec.wait(t, "term:closed:"+sid).data.(map[string]any)["reason"].(string); !strings.Contains(r, "not available") {
		t.Fatal(r)
	}
	var calls []telnetCall
	var fk deviceFakes
	installTelnet(h, &calls, &fk)
	h.app.Vault.Lock()
	sid2, _ := h.open(TelnetID(host.ID), 80, 24)
	if r := h.rec.wait(t, "term:closed:"+sid2).data.(map[string]any)["reason"].(string); !strings.Contains(strings.ToLower(r), "unlock") {
		t.Fatalf("a locked vault cannot give its password: %s", r)
	}
	if len(calls) != 0 {
		t.Fatal("must not dial without the password")
	}
	h.app.Core.OpenTelnet = func(string, int, int, string, string, func([]byte)) (Shell, error) {
		return nil, errors.New("connection refused")
	}
	_ = h.app.Vault.Unlock(masterPW)
	sid3, _ := h.open(TelnetID(host.ID), 80, 24)
	if r := h.rec.wait(t, "term:closed:"+sid3).data.(map[string]any)["reason"].(string); r != "connection refused" {
		t.Fatal(r)
	}
	if e := h.waitLog(t, "Connection failed: connection refused"); e.OK || e.HostLabel != "switch" {
		t.Fatalf("%+v", e)
	}
}

func TestTelnetHasItsOwnLoginAndSavedPassword(t *testing.T) {
	h := newHarness(t).unlocked(t)
	var calls []telnetCall
	var fk deviceFakes
	installTelnet(h, &calls, &fk)
	host := telnetHost(t, h, domain.Host{Username: "ssh-user", TelnetEnabled: true, TelnetPort: 23, TelnetUsername: "operator"})
	if err := h.app.Host.SetTelnetPassword(host.ID, "s3cret"); err != nil {
		t.Fatal(err)
	}
	sid, err := h.open(TelnetID(host.ID), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	h.rec.wait(t, "term:ready:"+sid)
	if len(calls) != 1 || calls[0].user != "operator" || calls[0].pass != "s3cret" {
		t.Fatalf("the Telnet login is its own, not the SSH one: %+v", calls)
	}
	// no Telnet user name: the host's own is used; an empty password forgets the saved one
	if err := h.app.Host.SetTelnetPassword(host.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, _, pass, err := h.app.Core.telnetCredentials(domain.Host{Meta: host.Meta, TelnetEnabled: true, TelnetPort: 23, Hostname: "x"}); err != nil || pass != "" {
		t.Fatalf("%q %v", pass, err)
	}
	if err := h.app.Host.DeleteHost(host.ID); err != nil {
		t.Fatal(err)
	}
	if err := h.app.Host.SetTelnetPassword(host.ID, "x"); err == nil {
		t.Fatal("a deleted host takes no password")
	}
}

func TestTelnetLatin1ServersAreConvertedBothWays(t *testing.T) {
	h := newHarness(t).unlocked(t)
	var fk deviceFakes
	var calls []telnetCall
	installTelnet(h, &calls, &fk)
	host := telnetHost(t, h, domain.Host{TelnetEnabled: true, TelnetPort: 23, TelnetEncoding: "iso-8859-1"})
	sid, err := h.open(TelnetID(host.ID), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	h.rec.wait(t, "term:ready:"+sid)
	if err := h.app.Session.Write(sid, "café\r"); err != nil {
		t.Fatal(err)
	}
	// the device got the Latin-1 byte 0xE9, and what it echoed came back as UTF-8
	h.rec.waitOutput(t, sid, "echo:café\r")
	if got := latin1ToUTF8([]byte{0x63, 0xe9}); string(got) != "cé" {
		t.Fatalf("%q", got)
	}
	if _, err := h.app.Host.SaveHost(domain.Host{Meta: host.Meta, Label: "x", Hostname: "y", Port: 22, TelnetEncoding: "koi8-r"}); err == nil {
		t.Fatal("unknown encoding")
	}
}
