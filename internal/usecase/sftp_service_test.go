package usecase

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vvterm/internal/testssh"
)

func startSFTPServer(t *testing.T, seed map[string]string) *testssh.Server {
	t.Helper()
	s, err := testssh.Start(testssh.Config{User: "root", Password: "pw", SFTP: true, SFTPSeed: seed})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

// openSftp opens a session and answers the host key prompt.
func (h *harness) openSftp(t *testing.T, hostID, key string) SftpInfo {
	t.Helper()
	type res struct {
		info SftpInfo
		err  error
	}
	ch := make(chan res, 1)
	go func() { i, err := h.app.Sftp.Open(hostID, key); ch <- res{i, err} }()
	h.trust(t, key)
	r := <-ch
	if r.err != nil {
		t.Fatalf("open: %v", r.err)
	}
	return r.info
}

func TestSftpBrowseTransferRenameDelete(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startSFTPServer(t, map[string]string{"/readme.txt": "hello", "/projects/": ""})
	host := h.sshHost(t, "files", srv, "")
	info := h.openSftp(t, host.ID, "sftp-1")
	if info.SID == "" || info.Home != "/" || info.Host != "files" {
		t.Fatalf("%+v", info)
	}
	sf := h.app.Sftp

	list, err := sf.List(info.SID, "/")
	if err != nil || len(list) != 2 || list[0].Name != "projects" || !list[0].IsDir || list[1].Name != "readme.txt" {
		t.Fatalf("%v %+v", err, list)
	}
	if err := sf.Mkdir(info.SID, "/projects/new"); err != nil {
		t.Fatal(err)
	}

	src := filepath.Join(t.TempDir(), "report.txt")
	payload := strings.Repeat("line of text\n", 20000) // ~260 KB: several progress events
	if err := os.WriteFile(src, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	dest, err := sf.Upload(info.SID, src, "/projects/new", false)
	if err != nil || dest != "/projects/new/report.txt" {
		t.Fatalf("%v %q", err, dest)
	}
	h.rec.waitCount(t, "sftp:progress:"+info.SID, 1)
	last := h.rec.lastEvent("sftp:progress:" + info.SID).data.(map[string]any)
	if last["direction"] != "upload" || last["name"] != "report.txt" || last["done"] != last["total"] {
		t.Fatalf("final progress event: %v", last)
	}

	if _, err := sf.Upload(info.SID, src, "/projects/new", false); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("second upload without overwrite: %v", err)
	}
	if _, err := sf.Upload(info.SID, src, "/projects/new", true); err != nil {
		t.Fatalf("overwrite: %v", err)
	}

	out := filepath.Join(t.TempDir(), "downloaded.txt")
	if err := sf.Download(info.SID, dest, out, false); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != payload {
		t.Fatal("round trip changed the bytes")
	}
	if err := sf.Download(info.SID, dest, out, false); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("download over an existing file: %v", err)
	}

	if err := sf.Rename(info.SID, dest, "/projects/new/renamed.txt"); err != nil {
		t.Fatal(err)
	}
	if err := sf.Delete(info.SID, "/projects", false); err == nil {
		t.Fatal("deleted a non-empty directory without recursive")
	}
	if err := sf.Delete(info.SID, "/projects", true); err != nil {
		t.Fatal(err)
	}
	if list, _ := sf.List(info.SID, "/"); len(list) != 1 || list[0].Name != "readme.txt" {
		t.Fatalf("%+v", list)
	}
	if srv.Logins() != 1 {
		t.Fatalf("one connection expected, got %d", srv.Logins())
	}
}

func TestSftpSessionsAreIndependentAndCloseIsIdempotent(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startSFTPServer(t, map[string]string{"/a.txt": "a"})
	host := h.sshHost(t, "files", srv, "")
	a := h.openSftp(t, host.ID, "sftp-a")
	b, err := h.app.Sftp.Open(host.ID, "sftp-b") // known host now: no prompt
	if err != nil {
		t.Fatal(err)
	}
	if a.SID == b.SID {
		t.Fatal("sessions share an id")
	}
	if err := h.app.Sftp.Close(a.SID); err != nil {
		t.Fatal(err)
	}
	if err := h.app.Sftp.Close(a.SID); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if _, err := h.app.Sftp.List(a.SID, "/"); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("closed session still usable: %v", err)
	}
	if list, err := h.app.Sftp.List(b.SID, "/"); err != nil || len(list) != 1 {
		t.Fatalf("the other session must keep working: %v %+v", err, list)
	}
	if _, err := h.app.Sftp.List("nope", "/"); err == nil {
		t.Fatal("unknown session accepted")
	}
}

func TestSftpThroughAJumpHost(t *testing.T) {
	h := newHarness(t).unlocked(t)
	bastion := startServer(t) // no SFTP needed on the bastion
	target := startSFTPServer(t, map[string]string{"/x.txt": "x"})
	b := h.sshHost(t, "bastion", bastion, "")
	tg := h.sshHost(t, "target", target, b.ID)
	type res struct {
		info SftpInfo
		err  error
	}
	ch := make(chan res, 1)
	go func() { i, err := h.app.Sftp.Open(tg.ID, "sftp-j"); ch <- res{i, err} }()
	h.trust2(t, "sftp-j", 1)
	h.trust2(t, "sftp-j", 2)
	r := <-ch
	if r.err != nil {
		t.Fatal(r.err)
	}
	if list, err := h.app.Sftp.List(r.info.SID, "/"); err != nil || len(list) != 1 {
		t.Fatalf("%v %+v", err, list)
	}
	if bastion.Logins() != 1 || target.Logins() != 1 {
		t.Fatalf("bastion=%d target=%d", bastion.Logins(), target.Logins())
	}
}

func TestSftpConnectionLossIsReportedAndSessionDropped(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startSFTPServer(t, nil)
	host := h.sshHost(t, "files", srv, "")
	info := h.openSftp(t, host.ID, "sftp-l")
	srv.DropConnections()
	h.rec.wait(t, "sftp:closed:"+info.SID)
	if _, err := h.app.Sftp.List(info.SID, "/"); err == nil {
		t.Fatal("a lost session still answers")
	}
}

func TestSftpRefusedWithoutAnSFTPServerOrVaultOrAdapter(t *testing.T) {
	h := newHarness(t).unlocked(t)
	plain := startServer(t) // no sftp subsystem
	host := h.sshHost(t, "plain", plain, "")
	done := make(chan error, 1)
	go func() { _, err := h.app.Sftp.Open(host.ID, "sftp-n"); done <- err }()
	h.trust(t, "sftp-n")
	if err := <-done; err == nil {
		t.Fatal("a server without sftp must be reported")
	}

	srv := startSFTPServer(t, nil)
	locked := h.sshHost(t, "locked", srv, "")
	h.app.Vault.Lock()
	if _, err := h.app.Sftp.Open(locked.ID, "sftp-k"); err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("locked vault: %v", err)
	}
	if _, err := h.app.Sftp.Open(locked.ID, ""); err == nil {
		t.Fatal("empty prompt key accepted")
	}
	h.core.OpenRemoteFS = nil
	if _, err := h.app.Sftp.Open(locked.ID, "sftp-z"); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("without the adapter: %v", err)
	}
	if _, err := h.app.Sftp.Open("nope", "sftp-q"); err == nil {
		t.Fatal("unknown host accepted")
	}
}

func TestSftpRejectsDangerousPathsAndShutdownClosesSessions(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startSFTPServer(t, map[string]string{"/a": "a"})
	host := h.sshHost(t, "files", srv, "")
	info := h.openSftp(t, host.ID, "sftp-d")
	sf := h.app.Sftp
	for name, err := range map[string]error{
		"delete root":     sf.Delete(info.SID, "/", true),
		"relative delete": sf.Delete(info.SID, "a", false),
		"mkdir relative":  sf.Mkdir(info.SID, "../x"),
		"rename to root":  sf.Rename(info.SID, "/a", "/"),
	} {
		if err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := sf.Upload(info.SID, "/definitely/not/there.txt", "/", false); err == nil {
		t.Error("upload of a missing local file accepted")
	}
	if _, err := sf.Upload(info.SID, "", "/", false); err == nil {
		t.Error("empty local path accepted")
	}
	h.app.Shutdown()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := sf.List(info.SID, "/"); err != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("shutdown left the SFTP session open")
}

func TestSftpChmodReachesTheServerAndChecksTheBits(t *testing.T) {
	h := newHarness(t).unlocked(t)
	srv := startSFTPServer(t, map[string]string{"/a.txt": "a"})
	host := h.sshHost(t, "files", srv, "")
	info := h.openSftp(t, host.ID, "sftp-chmod")
	if err := h.app.Sftp.Chmod(info.SID, "/a.txt", 0o600); err != nil {
		t.Fatal(err)
	}
	// the test server keeps no permission bits: what is checked is that the request reaches the file
	if err := h.app.Sftp.Chmod(info.SID, "/missing.txt", 0o600); err == nil {
		t.Fatal("a file that is not there")
	}
	for _, bad := range []int{-1, 0o10000} {
		if err := h.app.Sftp.Chmod(info.SID, "/a.txt", bad); err == nil {
			t.Fatalf("%o accepted", bad)
		}
	}
	if err := h.app.Sftp.Chmod("nope", "/a.txt", 0o644); err == nil {
		t.Fatal("closed session")
	}
}
