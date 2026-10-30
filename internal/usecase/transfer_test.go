package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"vvterm/internal/domain"
)

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if strings.HasSuffix(rel, "/") {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func sorted(s []string) []string { c := append([]string(nil), s...); sort.Strings(c); return c }

func eq(a, b []string) bool { return strings.Join(sorted(a), "|") == strings.Join(sorted(b), "|") }

func openForTransfer(t *testing.T) (*harness, SftpInfo) {
	t.Helper()
	h := newHarness(t).unlocked(t)
	srv := startSFTPServer(t, map[string]string{"/inbox/": ""})
	host := h.sshHost(t, "files", srv, "")
	return h, h.openSftp(t, host.ID, "sftp-1")
}

func TestUploadAllSendsFoldersWithEverythingInside(t *testing.T) {
	h, info := openForTransfer(t)
	src := filepath.Join(t.TempDir(), "site")
	writeTree(t, src, map[string]string{
		"index.html": "<h1>hi</h1>", "css/app.css": "body{}", "css/deep/more.css": "a{}", "empty/": "",
	})
	if err := os.Symlink("/etc/passwd", filepath.Join(src, "leak")); err != nil {
		t.Fatal(err)
	}
	loose := filepath.Join(t.TempDir(), "notes.txt")
	writeTree(t, filepath.Dir(loose), map[string]string{"notes.txt": "n"})

	res, err := h.app.Sftp.UploadAll(info.SID, []string{src, loose}, "/inbox", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 4 || res.Bytes != int64(len("<h1>hi</h1>")+len("body{}")+len("a{}")+1) {
		t.Fatalf("%+v", res)
	}
	if res.Dirs != 4 { // site, css, css/deep, empty
		t.Fatalf("dirs=%d", res.Dirs)
	}
	if !eq(res.Ignored, []string{"site/leak"}) || len(res.Skipped) != 0 {
		t.Fatalf("a link is never followed: %+v", res)
	}
	top, _ := h.app.Sftp.List(info.SID, "/inbox")
	names := []string{}
	for _, e := range top {
		names = append(names, e.Name)
	}
	if !eq(names, []string{"site", "notes.txt"}) {
		t.Fatalf("%v", names)
	}
	deep, err := h.app.Sftp.List(info.SID, "/inbox/site/css/deep")
	if err != nil || len(deep) != 1 || deep[0].Name != "more.css" {
		t.Fatalf("%v %+v", err, deep)
	}
	if empty, err := h.app.Sftp.List(info.SID, "/inbox/site/empty"); err != nil || len(empty) != 0 {
		t.Fatalf("an empty folder is uploaded too: %v %+v", err, empty)
	}
	if h.rec.count("sftp:progress:"+info.SID) == 0 {
		t.Fatal("progress must be reported")
	}
	last := h.rec.lastEvent("sftp:progress:" + info.SID).data.(map[string]any)
	if last["done"] != last["total"] || last["direction"] != "upload" {
		t.Fatalf("the batch ends complete: %+v", last)
	}
}

func TestUploadAllSkipsExistingFilesUntilToldToReplace(t *testing.T) {
	h, info := openForTransfer(t)
	src := filepath.Join(t.TempDir(), "docs")
	writeTree(t, src, map[string]string{"a.txt": "one", "sub/b.txt": "two"})
	if _, err := h.app.Sftp.UploadAll(info.SID, []string{src}, "/inbox", false); err != nil {
		t.Fatal(err)
	}
	writeTree(t, src, map[string]string{"a.txt": "ONE-NEW", "sub/b.txt": "TWO-NEW", "sub/c.txt": "three"})
	res, err := h.app.Sftp.UploadAll(info.SID, []string{src}, "/inbox", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != 1 || !eq(res.Skipped, []string{"docs/a.txt", "docs/sub/b.txt"}) {
		t.Fatalf("only the new file goes up, the rest is reported: %+v", res)
	}
	dst := t.TempDir()
	if _, err := h.app.Sftp.DownloadAll(info.SID, []string{"/inbox/docs"}, dst, false); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dst, "docs", "a.txt")) != "one" {
		t.Fatal("an existing remote file must not have been replaced")
	}
	res, err = h.app.Sftp.UploadAll(info.SID, []string{src}, "/inbox", true)
	if err != nil || res.Files != 3 || len(res.Skipped) != 0 {
		t.Fatalf("%v %+v", err, res)
	}
	dst2 := t.TempDir()
	if _, err := h.app.Sftp.DownloadAll(info.SID, []string{"/inbox/docs"}, dst2, false); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dst2, "docs", "a.txt")) != "ONE-NEW" || readFile(t, filepath.Join(dst2, "docs", "sub", "c.txt")) != "three" {
		t.Fatal("replace must overwrite")
	}
}

func TestDownloadAllSavesFoldersAndSkipsExisting(t *testing.T) {
	h, info := openForTransfer(t)
	src := filepath.Join(t.TempDir(), "proj")
	writeTree(t, src, map[string]string{"main.go": "package main", "pkg/util.go": "package pkg", "pkg/empty/": ""})
	if _, err := h.app.Sftp.UploadAll(info.SID, []string{src}, "/inbox", false); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	res, err := h.app.Sftp.DownloadAll(info.SID, []string{"/inbox/proj", "/inbox/proj/main.go"}, dst, false)
	if err != nil {
		t.Fatal(err)
	}
	// a file chosen on its own lands directly in the folder, next to the dragged folder
	if res.Files != 3 || res.Dirs != 3 || len(res.Skipped) != 0 || readFile(t, filepath.Join(dst, "main.go")) != "package main" {
		t.Fatalf("%+v", res)
	}
	if readFile(t, filepath.Join(dst, "proj", "pkg", "util.go")) != "package pkg" {
		t.Fatal("content")
	}
	if st, err := os.Stat(filepath.Join(dst, "proj", "pkg", "empty")); err != nil || !st.IsDir() {
		t.Fatal("empty folder")
	}
	if err := os.WriteFile(filepath.Join(dst, "proj", "main.go"), []byte("edited locally"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err = h.app.Sftp.DownloadAll(info.SID, []string{"/inbox/proj"}, dst, false)
	if err != nil || res.Files != 0 || len(res.Skipped) != 2 {
		t.Fatalf("%v %+v", err, res)
	}
	if readFile(t, filepath.Join(dst, "proj", "main.go")) != "edited locally" {
		t.Fatal("a local file must survive without overwrite")
	}
	res, err = h.app.Sftp.DownloadAll(info.SID, []string{"/inbox/proj"}, dst, true)
	if err != nil || res.Files != 2 || readFile(t, filepath.Join(dst, "proj", "main.go")) != "package main" {
		t.Fatalf("%v %+v", err, res)
	}
}

func TestTransferRefusesBadInput(t *testing.T) {
	h, info := openForTransfer(t)
	sf := h.app.Sftp
	tmp := t.TempDir()
	if _, err := sf.UploadAll("nope", []string{tmp}, "/inbox", false); err == nil {
		t.Fatal("unknown session")
	}
	if _, err := sf.UploadAll(info.SID, nil, "/inbox", false); err == nil {
		t.Fatal("nothing to upload")
	}
	if _, err := sf.UploadAll(info.SID, []string{"relative/path"}, "/inbox", false); err == nil {
		t.Fatal("relative path")
	}
	if _, err := sf.UploadAll(info.SID, []string{filepath.Join(tmp, "missing")}, "/inbox", false); err == nil {
		t.Fatal("missing local file")
	}
	if _, err := sf.UploadAll(info.SID, []string{"/"}, "/inbox", false); err == nil {
		t.Fatal("the file system root has no name")
	}
	if _, err := sf.DownloadAll(info.SID, nil, tmp, false); err == nil {
		t.Fatal("nothing to download")
	}
	if _, err := sf.DownloadAll(info.SID, []string{"/inbox"}, "relative", false); err == nil {
		t.Fatal("relative local folder")
	}
	for _, bad := range []string{"/", "inbox", "/inbox/../etc"} {
		if _, err := sf.DownloadAll(info.SID, []string{bad}, tmp, false); err == nil && bad != "/inbox/../etc" {
			t.Errorf("DownloadAll(%q) must fail", bad)
		}
	}
	if _, err := sf.DownloadAll(info.SID, []string{"/inbox/missing"}, tmp, false); err == nil || !strings.Contains(err.Error(), "no such") {
		t.Fatalf("%v", err)
	}
}

func TestUploadRefusesFoldersNestedTooDeeply(t *testing.T) {
	h, info := openForTransfer(t)
	root := filepath.Join(t.TempDir(), "deep")
	p := root
	for i := 0; i < maxTransferDepth+3; i++ {
		p = filepath.Join(p, "d")
	}
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Skipf("cannot create a path this deep here: %v", err)
	}
	if _, err := h.app.Sftp.UploadAll(info.SID, []string{root}, "/inbox", false); err == nil || !strings.Contains(err.Error(), "nested too deeply") {
		t.Fatalf("%v", err)
	}
}

// fakeRemote lists fixed entries: a hostile server can name files anything.
type fakeRemote struct {
	mu      sync.Mutex
	listing map[string][]domain.RemoteEntry
	got     []string
}

func (f *fakeRemote) Home() (string, error) { return "/", nil }
func (f *fakeRemote) List(dir string) ([]domain.RemoteEntry, error) {
	if l, ok := f.listing[dir]; ok {
		return l, nil
	}
	return nil, errors.New("no such directory")
}
func (f *fakeRemote) Mkdir(string) error                      { return nil }
func (f *fakeRemote) Rename(a, b string) error                { return nil }
func (f *fakeRemote) Remove(string, bool) error               { return nil }
func (f *fakeRemote) Stat(string) (domain.RemoteEntry, error) { return domain.RemoteEntry{}, nil }
func (f *fakeRemote) Upload(_ context.Context, l, r string, o bool, p func(int64, int64)) error {
	return nil
}
func (f *fakeRemote) Download(_ context.Context, r, l string, o bool, p func(int64, int64)) error {
	f.mu.Lock()
	f.got = append(f.got, l)
	f.mu.Unlock()
	return os.WriteFile(l, []byte("x"), 0o644)
}
func (f *fakeRemote) Close() error { return nil }

func TestDownloadIgnoresNamesThatWouldEscapeTheFolder(t *testing.T) {
	root := t.TempDir()
	dst := filepath.Join(root, "downloads")
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	f := &fakeRemote{listing: map[string][]domain.RemoteEntry{
		"/srv": {{Name: "evil", Path: "/srv/evil", IsDir: true}, {Name: "ok.txt", Path: "/srv/ok.txt", Size: 1}},
		"/srv/evil": {
			{Name: "../../escaped.txt", Path: "/srv/evil/../../escaped.txt", Size: 1},
			{Name: "..", Path: "/srv", IsDir: true}, {Name: "a/b", Path: "/srv/evil/a/b", Size: 1}, {Name: "", Path: "/srv/evil/", Size: 1},
			{Name: "good.txt", Path: "/srv/evil/good.txt", Size: 1},
		},
		"/": {{Name: "srv", Path: "/srv", IsDir: true}},
	}}
	res := newResult()
	jobs, err := planDownload(f, []string{"/srv/evil", "/srv/ok.txt"}, dst, &res)
	if err != nil {
		t.Fatal(err)
	}
	for _, j := range jobs {
		if !strings.HasPrefix(j.dst, dst+string(filepath.Separator)) {
			t.Fatalf("%q is outside %q", j.dst, dst)
		}
	}
	if len(jobs) != 3 || len(res.Ignored) != 4 { // evil/, good.txt, ok.txt  — four unsafe names ignored
		t.Fatalf("jobs=%d ignored=%v", len(jobs), res.Ignored)
	}
	if _, err := os.Stat(filepath.Join(root, "escaped.txt")); !os.IsNotExist(err) {
		t.Fatal("nothing may be written outside the chosen folder")
	}
	for _, n := range []string{"", ".", "..", "a/b", `a\b`, "x\x00y"} {
		if safeName(n) {
			t.Errorf("safeName(%q) must be false", n)
		}
	}
	if !safeName("file with spaces & ünïcode.txt") {
		t.Fatal("ordinary names are fine")
	}
}

func (f *fakeRemote) Chmod(p string, m uint32) error { return nil }
