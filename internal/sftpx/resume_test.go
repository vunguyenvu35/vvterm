package sftpx

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/domain"
	"vvterm/internal/sshx"
	"vvterm/internal/testssh"
)

var errPause = errors.New("paused")

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// stopAfter cancels ctx with cause once more than n bytes were reported.
func stopAfter(n int64, cancel context.CancelCauseFunc, cause error) func(done, total int64) {
	return func(done, _ int64) {
		if done > n {
			cancel(cause)
		}
	}
}

func partsOnServer(t *testing.T, fs *FS) []string {
	t.Helper()
	list, err := fs.List("/")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range list {
		if strings.Contains(e.Name, partSuffix) {
			out = append(out, e.Name)
		}
	}
	return out
}

func TestUploadContinuesAnInterruptedCopy(t *testing.T) {
	fs := newFS(t, nil)
	data := randomBytes(t, 2<<20)
	src := local(t, "big.bin", string(data))

	ctx, cancel := context.WithCancelCause(bg)
	err := fs.Upload(ctx, src, "/big.bin", false, stopAfter(700<<10, cancel, errPause))
	if !errors.Is(err, errPause) {
		t.Fatalf("interrupted upload: %v", err)
	}
	if parts := partsOnServer(t, fs); len(parts) != 1 {
		t.Fatalf("the partial file must stay for the next try: %v", parts)
	}
	if list, _ := fs.List("/"); len(list) != 1 {
		t.Fatal("a half-written target must not exist")
	}

	var first int64 = -1
	if err := fs.Upload(bg, src, "/big.bin", false, func(done, _ int64) {
		if first < 0 {
			first = done
		}
	}); err != nil {
		t.Fatal(err)
	}
	if first < 256<<10 {
		t.Fatalf("the second try started from scratch (first progress %d)", first)
	}
	dst := filepath.Join(t.TempDir(), "back.bin")
	if err := fs.Download(bg, "/big.bin", dst, false, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dst); !bytes.Equal(got, data) {
		t.Fatal("the continued upload differs from the source")
	}
	if parts := partsOnServer(t, fs); len(parts) != 0 {
		t.Fatalf("partial file left after the copy finished: %v", parts)
	}
}

func TestUploadDoesNotContinueACopyOfAnotherVersion(t *testing.T) {
	fs := newFS(t, nil)
	src := local(t, "v.bin", string(randomBytes(t, 1<<20)))
	ctx, cancel := context.WithCancelCause(bg)
	if err := fs.Upload(ctx, src, "/v.bin", false, stopAfter(400<<10, cancel, errPause)); !errors.Is(err, errPause) {
		t.Fatal(err)
	}
	newer := randomBytes(t, 900<<10)
	if err := os.WriteFile(src, newer, 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	_ = os.Chtimes(src, later, later)
	if err := fs.Upload(bg, src, "/v.bin", false, nil); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "v.bin")
	if err := fs.Download(bg, "/v.bin", dst, false, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dst); !bytes.Equal(got, newer) {
		t.Fatal("bytes of the old version leaked into the new copy")
	}
}

func TestCancelForGoodDeletesThePartialUpload(t *testing.T) {
	fs := newFS(t, nil)
	src := local(t, "c.bin", string(randomBytes(t, 1<<20)))
	ctx, cancel := context.WithCancelCause(bg)
	if err := fs.Upload(ctx, src, "/c.bin", false, stopAfter(300<<10, cancel, domain.ErrTransferDiscarded)); !errors.Is(err, domain.ErrTransferDiscarded) {
		t.Fatal(err)
	}
	if list, _ := fs.List("/"); len(list) != 0 {
		t.Fatalf("a cancelled upload left files: %+v", list)
	}
}

func TestDownloadContinuesAnInterruptedCopy(t *testing.T) {
	data := randomBytes(t, 2<<20)
	fs := newFS(t, map[string]string{"/big.bin": string(data)})
	dir := t.TempDir()
	dst := filepath.Join(dir, "big.bin")

	ctx, cancel := context.WithCancelCause(bg)
	if err := fs.Download(ctx, "/big.bin", dst, false, stopAfter(700<<10, cancel, errPause)); !errors.Is(err, errPause) {
		t.Fatalf("interrupted download: %v", err)
	}
	if _, err := os.Stat(dst); err == nil {
		t.Fatal("a half-written target must not exist")
	}
	var first int64 = -1
	if err := fs.Download(bg, "/big.bin", dst, false, func(done, _ int64) {
		if first < 0 {
			first = done
		}
	}); err != nil {
		t.Fatal(err)
	}
	if first < 256<<10 {
		t.Fatalf("the second try started from scratch (first progress %d)", first)
	}
	if got, _ := os.ReadFile(dst); !bytes.Equal(got, data) {
		t.Fatal("the continued download differs from the source")
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Fatalf("partial file left after the copy finished: %v", ents)
	}
}

func TestCancelForGoodDeletesThePartialDownload(t *testing.T) {
	fs := newFS(t, map[string]string{"/c.bin": string(randomBytes(t, 1<<20))})
	dir := t.TempDir()
	ctx, cancel := context.WithCancelCause(bg)
	if err := fs.Download(ctx, "/c.bin", filepath.Join(dir, "c.bin"), false, stopAfter(300<<10, cancel, domain.ErrTransferDiscarded)); !errors.Is(err, domain.ErrTransferDiscarded) {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("a cancelled download left files: %v", ents)
	}
}

func TestOverwriteKeepsThePermissionsOfTheReplacedFile(t *testing.T) {
	// the in-memory server ignores permissions: use the real file system, inside a temporary folder
	srv, err := testssh.Start(testssh.Config{User: "u", Password: "p", SFTP: true, SFTPRealFS: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	d := &sshx.Dialer{HostKeys: &sshx.HostKeyChecker{Path: filepath.Join(t.TempDir(), "kh"),
		Prompt: func(string, ssh.PublicKey) (bool, error) { return true, nil }}, Timeout: 5 * time.Second}
	cl, err := d.Dial([]sshx.Hop{{Label: "t", Hostname: "127.0.0.1", Port: srv.Port(), Username: "u", Auth: sshx.PasswordAuth("p")}})
	if err != nil {
		t.Fatal(err)
	}
	fs, err := Open(cl.Client)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fs.Close(); cl.Close() })

	target := filepath.Join(t.TempDir(), "run.sh")
	if err := os.WriteFile(target, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := fs.Upload(bg, local(t, "run.sh", "new"), target, true, nil); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(target); string(got) != "new" || st.Mode().Perm() != 0o750 {
		t.Fatalf("content %q mode %v", got, st.Mode().Perm())
	}
}

func TestStatDescribesAFileAndRefusesBadPaths(t *testing.T) {
	fs := newFS(t, map[string]string{"/a.txt": "12345", "/d/": ""})
	if st, err := fs.Stat("/a.txt"); err != nil || st.Size != 5 || st.IsDir {
		t.Fatalf("%v %+v", err, st)
	}
	if st, err := fs.Stat("/d"); err != nil || !st.IsDir {
		t.Fatalf("%v %+v", err, st)
	}
	if _, err := fs.Stat("/missing"); err == nil {
		t.Fatal("stat of a missing file succeeded")
	}
	if _, err := fs.Stat("relative"); !errors.Is(err, ErrBadPath) {
		t.Fatal(err)
	}
}
