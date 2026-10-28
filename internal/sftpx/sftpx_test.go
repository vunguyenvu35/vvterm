package sftpx

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/sshx"
	"vvterm/internal/testssh"
)

func newFS(t *testing.T, seed map[string]string) *FS {
	t.Helper()
	srv, err := testssh.Start(testssh.Config{User: "u", Password: "p", SFTP: true, SFTPSeed: seed})
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
	return fs
}

func local(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestHomeAndListSortsDirectoriesFirst(t *testing.T) {
	fs := newFS(t, map[string]string{"/zeta.txt": "z", "/Alpha.txt": "aa", "/docs/": "", "/bin/": "", "/docs/readme.md": "hello"})
	home, err := fs.Home()
	if err != nil || home != "/" {
		t.Fatalf("home=%q err=%v", home, err)
	}
	list, err := fs.List("/")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range list {
		names = append(names, e.Name)
	}
	if strings.Join(names, ",") != "bin,docs,Alpha.txt,zeta.txt" {
		t.Fatalf("order: %v", names)
	}
	if !list[0].IsDir || list[2].IsDir || list[2].Size != 2 || list[2].Path != "/Alpha.txt" {
		t.Fatalf("%+v", list)
	}
	inner, err := fs.List("/docs")
	if err != nil || len(inner) != 1 || inner[0].Name != "readme.md" || inner[0].Size != 5 {
		t.Fatalf("%v %+v", err, inner)
	}
	if _, err := fs.List("/nope"); err == nil {
		t.Fatal("missing directory listed")
	}
}

func TestUploadDownloadRoundTripKeepsBytesAndReportsProgress(t *testing.T) {
	fs := newFS(t, nil)
	data := make([]byte, 300_000)
	_, _ = rand.Read(data)
	src := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(src, data, 0o600); err != nil {
		t.Fatal(err)
	}
	var seen []int64
	var total int64
	if err := fs.Upload(src, "/blob.bin", false, func(done, tot int64) { seen = append(seen, done); total = tot }); err != nil {
		t.Fatal(err)
	}
	if total != int64(len(data)) || len(seen) < 2 || seen[len(seen)-1] != total {
		t.Fatalf("progress total=%d calls=%d last=%v", total, len(seen), seen[len(seen)-1:])
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] < seen[i-1] {
			t.Fatal("progress went backwards")
		}
	}
	list, _ := fs.List("/")
	if len(list) != 1 || list[0].Name != "blob.bin" || list[0].Size != int64(len(data)) {
		t.Fatalf("temporary file left behind or wrong size: %+v", list)
	}
	dst := filepath.Join(t.TempDir(), "copy.bin")
	if err := fs.Download("/blob.bin", dst, false, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dst)
	if sha256.Sum256(got) != sha256.Sum256(data) {
		t.Fatal("downloaded bytes differ")
	}
}

func TestOverwriteIsRefusedUnlessRequested(t *testing.T) {
	fs := newFS(t, map[string]string{"/a.txt": "old"})
	up := local(t, "a.txt", "new content")
	if err := fs.Upload(up, "/a.txt", false, nil); !errors.Is(err, ErrExists) {
		t.Fatalf("upload over existing: %v", err)
	}
	if err := fs.Upload(up, "/a.txt", true, nil); err != nil {
		t.Fatalf("overwrite upload: %v", err)
	}
	dst := local(t, "d.txt", "keep me")
	if err := fs.Download("/a.txt", dst, false, nil); !errors.Is(err, ErrExists) {
		t.Fatalf("download over existing: %v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "keep me" {
		t.Fatal("a refused download changed the local file")
	}
	if err := fs.Download("/a.txt", dst, true, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "new content" {
		t.Fatalf("got %q", b)
	}
	list, _ := fs.List("/")
	if len(list) != 1 {
		t.Fatalf("part files left: %+v", list)
	}
}

func TestFailedDownloadLeavesNoPartFile(t *testing.T) {
	fs := newFS(t, nil)
	dir := t.TempDir()
	if err := fs.Download("/missing.txt", filepath.Join(dir, "x.txt"), false, nil); err == nil {
		t.Fatal("download of a missing file succeeded")
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 0 {
		t.Fatalf("leftover files: %v", ents)
	}
}

func TestMkdirRenameAndRemove(t *testing.T) {
	fs := newFS(t, map[string]string{"/f.txt": "x"})
	if err := fs.Mkdir("/newdir"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Mkdir("/newdir"); err == nil {
		t.Fatal("mkdir over an existing directory succeeded")
	}
	if err := fs.Rename("/f.txt", "/newdir/g.txt"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Rename("/newdir/g.txt", "/newdir"); !errors.Is(err, ErrExists) {
		t.Fatalf("rename onto an existing name: %v", err)
	}
	if err := fs.Remove("/newdir", false); err == nil {
		t.Fatal("removed a non-empty directory without recursive")
	}
	if err := fs.Remove("/newdir", true); err != nil {
		t.Fatal(err)
	}
	if list, _ := fs.List("/"); len(list) != 0 {
		t.Fatalf("%+v", list)
	}
}

func TestPathValidation(t *testing.T) {
	fs := newFS(t, nil)
	bad := []string{"", "relative/path", "../etc", "/a\x00b"}
	for _, p := range bad {
		if _, err := fs.List(p); !errors.Is(err, ErrBadPath) {
			t.Errorf("List(%q): %v", p, err)
		}
		if err := fs.Mkdir(p); !errors.Is(err, ErrBadPath) {
			t.Errorf("Mkdir(%q): %v", p, err)
		}
	}
	for _, op := range []func() error{
		func() error { return fs.Remove("/", true) },
		func() error { return fs.Mkdir("/") },
		func() error { return fs.Rename("/", "/x") },
		func() error { return fs.Rename("/x", "/") },
		func() error { return fs.Remove("/a/..", true) }, // cleans to the root
	} {
		if err := op(); !errors.Is(err, ErrBadPath) {
			t.Errorf("operation on the root must be refused, got %v", err)
		}
	}
	if err := fs.Upload("relative.txt", "/x", false, nil); !errors.Is(err, ErrBadPath) {
		t.Errorf("relative local path: %v", err)
	}
	if err := fs.Download("/x", "relative.txt", false, nil); !errors.Is(err, ErrBadPath) {
		t.Errorf("relative local path: %v", err)
	}
	if err := fs.Upload(t.TempDir(), "/dir", false, nil); err == nil {
		t.Error("uploading a directory succeeded")
	}
}

func TestDownloadOfDirectoryIsRefused(t *testing.T) {
	fs := newFS(t, map[string]string{"/d/": ""})
	if err := fs.Download("/d", filepath.Join(t.TempDir(), "d"), false, nil); err == nil || !strings.Contains(err.Error(), "directory") {
		t.Fatalf("%v", err)
	}
}

func TestUploadedFileContentOnServer(t *testing.T) {
	fs := newFS(t, nil)
	up := local(t, "hello.txt", "héllo wörld\n")
	if err := fs.Upload(up, "/hello.txt", false, nil); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "back.txt")
	if err := fs.Download("/hello.txt", dst, false, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); !bytes.Equal(b, []byte("héllo wörld\n")) {
		t.Fatalf("%q", b)
	}
	st, _ := os.Stat(dst)
	if st.Mode().Perm() != 0o644 {
		t.Fatalf("downloaded file mode %v", st.Mode().Perm())
	}
}
