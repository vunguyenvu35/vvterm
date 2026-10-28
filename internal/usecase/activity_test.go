package usecase

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vvterm/internal/domain"
)

func (h *harness) logs(t *testing.T, f domain.ActivityFilter) []domain.ActivityEntry {
	t.Helper()
	got, err := h.app.Log.List(f)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// waitLog waits for a line containing want (events from background sessions arrive a moment later).
func (h *harness) waitLog(t *testing.T, want string) domain.ActivityEntry {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range h.logs(t, domain.ActivityFilter{}) {
			if strings.Contains(e.Message, want) {
				return e
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	var all []string
	for _, e := range h.logs(t, domain.ActivityFilter{}) {
		all = append(all, e.Message)
	}
	t.Fatalf("no log line with %q in %q", want, all)
	return domain.ActivityEntry{}
}

func TestLogRecordsConnectingAndClosingATab(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	sid, err := h.open(host.ID, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	h.trust(t, sid)
	h.rec.wait(t, "term:ready:"+sid)
	e := h.waitLog(t, "Connected to 127.0.0.1:")
	if e.Kind != domain.ActConnect || !e.OK || e.HostLabel != "web" || e.HostID != host.ID {
		t.Fatalf("%+v", e)
	}
	if err := h.app.Session.Close(sid); err != nil {
		t.Fatal(err)
	}
	if e := h.waitLog(t, "Closed by you"); e.Kind != domain.ActDisconnect || !e.OK {
		t.Fatalf("%+v", e)
	}
	if h.rec.count("log:added") == 0 {
		t.Fatal("the UI is told when a line is added")
	}
}

func TestLogRecordsAFailedConnectionAndALostOne(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "gone", srv, "")
	srv.Close()
	sid, _ := h.open(host.ID, 80, 24)
	h.rec.wait(t, "term:closed:"+sid)
	if e := h.waitLog(t, "Connection failed"); e.OK || e.Kind != domain.ActConnect || e.HostLabel != "gone" {
		t.Fatalf("%+v", e)
	}

	srv2 := startServer(t)
	host2 := h.sshHost(t, "flaky", srv2, "")
	sid2, _ := h.open(host2.ID, 80, 24)
	h.trust(t, sid2)
	h.rec.wait(t, "term:ready:"+sid2)
	srv2.Close() // the link drops under the open tab
	if e := h.waitLog(t, "Connection lost"); e.OK || e.Kind != domain.ActDisconnect || e.HostLabel != "flaky" {
		t.Fatalf("%+v", e)
	}
}

func TestLogRecordsHostKeyDecisions(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	sid, _ := h.open(host.ID, 80, 24)
	h.trust(t, sid)
	if e := h.waitLog(t, "Trusted the host key SHA256:"); e.Kind != domain.ActHostKey || !e.OK {
		t.Fatalf("%+v", e)
	}

	srv2 := startServer(t)
	host2 := h.sshHost(t, "stranger", srv2, "")
	sid2, _ := h.open(host2.ID, 80, 24)
	h.rec.wait(t, "term:hostkey:"+sid2)
	if err := h.app.Session.TrustHostKey(sid2, ""); err != nil {
		t.Fatal(err)
	}
	if e := h.waitLog(t, "Did not trust the host key"); e.OK {
		t.Fatalf("%+v", e)
	}
}

func TestLogRecordsForwardsStartingStoppingAndFailing(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "bastion", srv, "")
	f, err := h.app.Forward.SaveForward(domain.PortForward{HostID: host.ID, Type: domain.ForwardDynamic, Label: "SOCKS", BindPort: 0})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- h.app.Forward.Start(f.ID) }()
	h.trust(t, "fwd-"+f.ID)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if e := h.waitLog(t, `Started dynamic forward "SOCKS"`); e.Kind != domain.ActForward || !e.OK || e.HostLabel != "bastion" {
		t.Fatalf("%+v", e)
	}
	if err := h.app.Forward.Stop(f.ID); err != nil {
		t.Fatal(err)
	}
	h.waitLog(t, `Stopped dynamic forward "SOCKS"`)

	dead := startServer(t)
	host2 := h.sshHost(t, "dead", dead, "")
	dead.Close()
	f2, _ := h.app.Forward.SaveForward(domain.PortForward{HostID: host2.ID, Type: domain.ForwardDynamic, BindPort: 0})
	if err := h.app.Forward.Start(f2.ID); err == nil {
		t.Fatal("must fail")
	}
	if e := h.waitLog(t, "Could not start dynamic forward"); e.OK || e.HostLabel != "dead" {
		t.Fatalf("%+v", e)
	}
}

func TestLogRecordsSFTPAndTransfers(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startSFTPServer(t, map[string]string{"/inbox/": ""})
	host := h.sshHost(t, "files", srv, "")
	info := h.openSftp(t, host.ID, "sftp-1")
	if e := h.waitLog(t, "SFTP connection opened"); e.Kind != domain.ActSFTP || e.HostLabel != "files" {
		t.Fatalf("%+v", e)
	}
	src := filepath.Join(t.TempDir(), "docs")
	if err := os.MkdirAll(filepath.Join(src, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(src, "a.txt"), []byte("hello"), 0o644)
	_ = os.WriteFile(filepath.Join(src, "sub", "b.txt"), []byte("world!"), 0o644)
	if _, err := h.app.Sftp.UploadAll(info.SID, []string{src}, "/inbox", false); err != nil {
		t.Fatal(err)
	}
	if e := h.waitLog(t, "Uploaded 2 files and 2 folders (11 B) to /inbox"); e.Kind != domain.ActTransfer || !e.OK {
		t.Fatalf("%+v", e)
	}
	dst := t.TempDir()
	if _, err := h.app.Sftp.DownloadAll(info.SID, []string{"/inbox/docs"}, dst, false); err != nil {
		t.Fatal(err)
	}
	h.waitLog(t, "Saved 2 files and 2 folders (11 B) into "+dst)
	if _, err := h.app.Sftp.UploadAll(info.SID, []string{filepath.Join(src, "missing")}, "/inbox", false); err == nil {
		t.Fatal("must fail")
	}
	if e := h.waitLog(t, "Upload failed"); e.OK {
		t.Fatalf("%+v", e)
	}
	if _, err := h.app.Sftp.UploadAll(info.SID, []string{src}, "/inbox", false); err != nil {
		t.Fatal(err)
	}
	h.waitLog(t, "2 left as they were")
}

func TestLogRecordsVaultAndSyncWithoutSecrets(t *testing.T) {
	h := newHarness(t).unlocked(t)
	h.app.Vault.Lock()
	h.waitLog(t, "Vault locked")
	if err := h.app.Vault.Unlock("definitely the wrong password"); err == nil {
		t.Fatal("must fail")
	}
	if e := h.waitLog(t, "Unlock failed"); e.OK || e.Kind != domain.ActVault {
		t.Fatalf("%+v", e)
	}
	if err := h.app.Vault.Unlock(masterPW); err != nil {
		t.Fatal(err)
	}
	h.waitLog(t, "Vault unlocked")
	if err := h.app.Sync.Configure("file:///nonexistent-vvterm-repo"); err != nil {
		t.Fatal(err)
	}
	if err := h.app.Sync.SyncNow(); err == nil {
		t.Fatal("syncing with a repository that does not exist must fail")
	}
	h.waitLog(t, "Sync failed")
	for _, e := range h.logs(t, domain.ActivityFilter{}) {
		for _, secret := range []string{masterPW, "definitely the wrong password"} {
			if strings.Contains(e.Message, secret) || strings.Contains(e.HostLabel, secret) {
				t.Fatalf("a secret reached the log: %+v", e)
			}
		}
	}
}

func TestLogServiceFiltersAndClears(t *testing.T) {
	h := newHarness(t).unlocked(t)
	h.app.Vault.Lock()
	h.app.Core.record(domain.ActTransfer, "", "box", "Uploaded 1 file", true)
	if got := h.logs(t, domain.ActivityFilter{Kinds: []string{domain.ActTransfer}}); len(got) != 1 || got[0].HostLabel != "box" {
		t.Fatalf("%+v", got)
	}
	if got := h.logs(t, domain.ActivityFilter{Query: "locked"}); len(got) != 1 {
		t.Fatalf("%+v", got)
	}
	before := h.rec.count("log:added")
	if err := h.app.Log.Clear(); err != nil {
		t.Fatal(err)
	}
	if got := h.logs(t, domain.ActivityFilter{}); len(got) != 0 || got == nil {
		t.Fatalf("%+v", got)
	}
	if h.rec.count("log:added") != before+1 {
		t.Fatal("the UI is told the log was cleared")
	}
}

func TestNoActivityStoreMeansNoHistoryAndNoCrash(t *testing.T) {
	h := newHarness(t).unlocked(t)
	h.app.Core.Activity = nil
	h.app.Core.record(domain.ActVault, "", "", "x", true)
	if got, err := h.app.Log.List(domain.ActivityFilter{}); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("%v %v", got, err)
	}
	if err := h.app.Log.Clear(); err != nil {
		t.Fatal(err)
	}
}

func TestKnownHostsListAndForgetThroughTheService(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startServer(t)
	host := h.sshHost(t, "web", srv, "")
	sid, _ := h.open(host.ID, 80, 24)
	h.trust(t, sid)
	h.rec.wait(t, "term:ready:"+sid)
	list, err := h.app.KnownHost.List()
	if err != nil || len(list) != 1 || list[0].KeyType != "ssh-ed25519" || !strings.HasPrefix(list[0].Fingerprint, "SHA256:") || !strings.Contains(list[0].Host, "127.0.0.1") {
		t.Fatalf("%v %+v", err, list)
	}
	if err := h.app.KnownHost.Forget(list[0].Host, list[0].Fingerprint); err != nil {
		t.Fatal(err)
	}
	if again, _ := h.app.KnownHost.List(); len(again) != 0 {
		t.Fatalf("%+v", again)
	}
	if e := h.waitLog(t, "Forgot the host key "+list[0].Fingerprint); e.Kind != domain.ActHostKey {
		t.Fatalf("%+v", e)
	}
	if err := h.app.KnownHost.Forget("nope", "SHA256:x"); err == nil {
		t.Fatal("an unknown host cannot be forgotten")
	}
	// the next connection asks again
	sid2, _ := h.open(host.ID, 80, 24)
	h.rec.wait(t, "term:hostkey:"+sid2)
	_ = h.app.Session.TrustHostKey(sid2, "")
}

func TestSummarizeTransferAndByteFormatting(t *testing.T) {
	if got := summarizeTransfer("Uploaded", TransferResult{Files: 1, Bytes: 1536}, "to /x"); got != "Uploaded 1 file (1.5 KB) to /x" {
		t.Fatal(got)
	}
	if got := summarizeTransfer("Saved", TransferResult{Dirs: 3, Files: 12, Bytes: 5 << 20, Skipped: []string{"a"}}, "into /y"); got != "Saved 12 files and 3 folders (5.0 MB) into /y, 1 left as they were" {
		t.Fatal(got)
	}
	if got := summarizeTransfer("Saved", TransferResult{}, "into /y"); got != "Nothing to transfer" {
		t.Fatal(got)
	}
	if humanBytes(0) != "0 B" || humanBytes(1023) != "1023 B" || humanBytes(200<<30) != "200 GB" {
		t.Fatal("bytes")
	}
}
