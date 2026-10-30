package usecase

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func realSession(t *testing.T, h *harness, seed map[string]string) string {
	t.Helper()
	srv := startSFTPServer(t, seed)
	host := h.sshHost(t, "files", srv, "")
	return h.openSftp(t, host.ID, "q-"+host.ID).SID
}

func remoteNames(t *testing.T, h *harness, sid, dir string) []string {
	t.Helper()
	list, err := h.app.Sftp.List(sid, dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range list {
		out = append(out, e.Name)
	}
	sort.Strings(out)
	return out
}

func TestQueueUploadsAFolderInTheBackgroundAndReportsIt(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, map[string]string{"/dest/": ""})
	src := filepath.Join(t.TempDir(), "project")
	writeTree(t, src, map[string]string{"main.go": "package main", "pkg/util.go": "package pkg", "pkg/deep/x.txt": "x"})

	id, err := h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "upload", Sources: []string{src}, DestDir: "/dest"})
	if err != nil {
		t.Fatal(err)
	}
	j := waitState(t, h, sid, id, "done")
	if j.Name != "project" || j.Files != 3 || j.Dirs != 3 || j.Bytes == 0 || j.Total != j.Bytes || j.Done != j.Total {
		t.Fatalf("%+v", j)
	}
	if got := remoteNames(t, h, sid, "/dest/project/pkg"); !reflect.DeepEqual(got, []string{"deep", "util.go"}) {
		t.Fatalf("%v", got)
	}
	last := h.rec.lastEvent("sftp:queue:" + sid).data.([]QueueJob)
	if len(last) != 1 || last[0].State != "done" {
		t.Fatalf("last queue event: %+v", last)
	}
	if h.rec.count("sftp:queue:"+sid) < 3 {
		t.Fatal("the screen must hear about every change of state")
	}
}

func TestQueueDownloadsAFolder(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, map[string]string{"/src/a.txt": "aaa", "/src/inner/b.txt": "bbb"})
	out := t.TempDir()
	id, err := h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "download", Sources: []string{"/src"}, DestDir: out})
	if err != nil {
		t.Fatal(err)
	}
	if j := waitState(t, h, sid, id, "done"); j.Files != 2 {
		t.Fatalf("%+v", j)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "src", "inner", "b.txt")); string(b) != "bbb" {
		t.Fatalf("%q", b)
	}
}

func TestConflictsListWhatWouldBeReplaced(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, map[string]string{"/dest/a.txt": "old", "/dest/sub/c.txt": "old"})
	src := filepath.Join(t.TempDir(), "set")
	writeTree(t, src, map[string]string{"a.txt": "new", "b.txt": "new", "sub/c.txt": "new", "sub/d.txt": "new"})
	got, err := h.app.Sftp.Conflicts(sid, "upload", []string{src}, "/dest")
	if err != nil || len(got) != 0 {
		t.Fatalf("nothing under /dest/set yet: %v %v", err, got) // the folder goes in as /dest/set
	}
	id, _ := h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "upload", Sources: []string{src}, DestDir: "/dest"})
	waitState(t, h, sid, id, "done")
	got, err = h.app.Sftp.Conflicts(sid, "upload", []string{src}, "/dest")
	sort.Strings(got)
	if err != nil || !reflect.DeepEqual(got, []string{"set/a.txt", "set/b.txt", "set/sub/c.txt", "set/sub/d.txt"}) {
		t.Fatalf("%v %v", err, got)
	}
	files := localFiles(t, "a.txt", "fresh.txt")
	got, _ = h.app.Sftp.Conflicts(sid, "upload", files, "/dest")
	if !reflect.DeepEqual(got, []string{"a.txt"}) {
		t.Fatalf("%v", got)
	}

	out := t.TempDir()
	writeTree(t, out, map[string]string{"a.txt": "here"})
	got, err = h.app.Sftp.Conflicts(sid, "download", []string{"/dest/a.txt", "/dest/sub"}, out)
	sort.Strings(got)
	if err != nil || !reflect.DeepEqual(got, []string{"a.txt"}) {
		t.Fatalf("%v %v", err, got)
	}
	if _, err := h.app.Sftp.Conflicts(sid, "sideways", files, "/dest"); err == nil {
		t.Fatal("unknown direction accepted")
	}
}

func TestQueueWithoutOverwriteSkipsAndWithOverwriteReplaces(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, map[string]string{"/dest/a.txt": "old"})
	files := localFiles(t, "a.txt")
	id, _ := h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "upload", Sources: files, DestDir: "/dest"})
	j := waitState(t, h, sid, id, "done")
	if j.Files != 0 || !reflect.DeepEqual(j.Skipped, []string{"a.txt"}) {
		t.Fatalf("%+v", j)
	}
	id, _ = h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "upload", Sources: files, DestDir: "/dest", Overwrite: true})
	if j = waitState(t, h, sid, id, "done"); j.Files != 1 || len(j.Skipped) != 0 {
		t.Fatalf("%+v", j)
	}
	out := filepath.Join(t.TempDir(), "a.txt")
	if err := h.app.Sftp.Download(sid, "/dest/a.txt", out, false); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != "data of a.txt" {
		t.Fatalf("%q", b)
	}
}

func TestSyncUpCopiesOnlyWhatIsNewOrChangedAndNeverDeletes(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, map[string]string{"/dest/same.txt": "same", "/dest/size.txt": "xx", "/dest/only-remote.txt": "keep me"})
	src := t.TempDir()
	writeTree(t, src, map[string]string{"same.txt": "same", "size.txt": "yyyy", "sub/new.txt": "new"})
	old := time.Now().Add(-time.Hour)
	_ = os.Chtimes(filepath.Join(src, "same.txt"), old, old)

	diff, err := h.app.Sftp.SyncPlan(sid, "sync-up", src, "/dest")
	if err != nil {
		t.Fatal(err)
	}
	if diff.Same != 1 || !reflect.DeepEqual(diff.Extra, []string{"only-remote.txt"}) || len(diff.Copy) != 2 ||
		diff.Copy[0] != (SyncItem{Path: "size.txt", Size: 4, Reason: "changed"}) || diff.Copy[1] != (SyncItem{Path: "sub/new.txt", Size: 3, Reason: "new"}) {
		t.Fatalf("%+v", diff)
	}
	if got := remoteNames(t, h, sid, "/dest"); len(got) != 3 {
		t.Fatalf("a plan must not change anything: %v", got)
	}

	id, err := h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "sync-up", Sources: []string{src}, DestDir: "/dest"})
	if err != nil {
		t.Fatal(err)
	}
	j := waitState(t, h, sid, id, "done")
	if j.Files != 2 || j.Dirs != 1 || j.Name != "Sync "+filepath.Base(src) {
		t.Fatalf("%+v", j)
	}
	if got := remoteNames(t, h, sid, "/dest"); !reflect.DeepEqual(got, []string{"only-remote.txt", "same.txt", "size.txt", "sub"}) {
		t.Fatalf("%v", got)
	}
	again, _ := h.app.Sftp.SyncPlan(sid, "sync-up", src, "/dest")
	if len(again.Copy) != 0 || again.Same != 3 {
		t.Fatalf("a second sync has nothing left to do: %+v", again)
	}
}

func TestSyncDownIntoAFolderThatDoesNotExistYet(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, map[string]string{"/data/a.txt": "aaa", "/data/d/b.txt": "bbb"})
	out := filepath.Join(t.TempDir(), "mirror")
	diff, err := h.app.Sftp.SyncPlan(sid, "sync-down", "/data", out)
	if err != nil || len(diff.Copy) != 2 || diff.Same != 0 {
		t.Fatalf("%v %+v", err, diff)
	}
	id, _ := h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "sync-down", Sources: []string{"/data"}, DestDir: out})
	if j := waitState(t, h, sid, id, "done"); j.Files != 2 {
		t.Fatalf("%+v", j)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "d", "b.txt")); string(b) != "bbb" {
		t.Fatalf("%q", b)
	}
	if again, _ := h.app.Sftp.SyncPlan(sid, "sync-down", "/data", out); len(again.Copy) != 0 {
		t.Fatalf("%+v", again)
	}
}

func TestSyncPlanRefusesUnsafeFolders(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, nil)
	for _, c := range []struct{ dir, src, dst string }{
		{"sync-up", "relative", "/x"},
		{"sync-up", t.TempDir(), "/"},
		{"sync-up", filepath.Join(t.TempDir(), "missing"), "/x"},
		{"sideways", t.TempDir(), "/x"},
	} {
		if _, err := h.app.Sftp.SyncPlan(sid, c.dir, c.src, c.dst); err == nil {
			t.Errorf("%+v accepted", c)
		}
	}
}

// ---- editing a remote file ----

func shortEditTimes(t *testing.T) {
	t.Helper()
	p, s := editPoll, editSettle
	editPoll, editSettle = 15*time.Millisecond, 40*time.Millisecond
	t.Cleanup(func() { editPoll, editSettle = p, s })
}

func waitEdit(t *testing.T, h *harness, sid string, n int) EditEvent {
	t.Helper()
	h.rec.waitCount(t, "sftp:edit:"+sid, n)
	return h.rec.lastEvent("sftp:edit:" + sid).data.(EditEvent)
}

func remoteText(t *testing.T, h *harness, sid, p string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "r.txt")
	if err := h.app.Sftp.Download(sid, p, out, false); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(out)
	return string(b)
}

func TestEditSavesBackToTheServerAndHoldsBackOnConflict(t *testing.T) {
	shortEditTimes(t)
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, map[string]string{"/f.txt": "one"})
	local := filepath.Join(t.TempDir(), "f.txt")
	if err := h.app.Sftp.Download(sid, "/f.txt", local, false); err != nil {
		t.Fatal(err)
	}
	if err := h.app.Sftp.EditStart(sid, "/f.txt", local); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, []byte("two two"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ev := waitEdit(t, h, sid, 1); ev.State != "uploaded" || ev.Remote != "/f.txt" {
		t.Fatalf("%+v", ev)
	}
	if got := remoteText(t, h, sid, "/f.txt"); got != "two two" {
		t.Fatalf("server has %q", got)
	}

	// somebody else changes the file on the server; then the local copy is saved again
	other := filepath.Join(t.TempDir(), "f.txt")
	_ = os.WriteFile(other, []byte("theirs! and longer"), 0o644) // sizes differ: an SFTP time has one-second precision
	if _, err := h.app.Sftp.Upload(sid, other, "/", true); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, []byte("three three three"), 0o644); err != nil {
		t.Fatal(err)
	}
	if ev := waitEdit(t, h, sid, 2); ev.State != "conflict" || !strings.Contains(ev.Message, "f.txt") {
		t.Fatalf("%+v", ev)
	}
	if got := remoteText(t, h, sid, "/f.txt"); got != "theirs! and longer" {
		t.Fatalf("a held-back save must not touch the server, it has %q", got)
	}
	if err := h.app.Sftp.EditPush(sid, "/f.txt", true); err != nil {
		t.Fatal(err)
	}
	if ev := waitEdit(t, h, sid, 3); ev.State != "uploaded" {
		t.Fatalf("%+v", ev)
	}
	if got := remoteText(t, h, sid, "/f.txt"); got != "three three three" {
		t.Fatalf("server has %q", got)
	}

	if err := h.app.Sftp.EditStop(sid, "/f.txt"); err != nil {
		t.Fatal(err)
	}
	if err := h.app.Sftp.EditPush(sid, "/f.txt", false); err == nil {
		t.Fatal("a stopped edit still answers")
	}
	_ = os.WriteFile(local, []byte("after stop"), 0o644)
	time.Sleep(200 * time.Millisecond)
	if got := remoteText(t, h, sid, "/f.txt"); got != "three three three" {
		t.Fatalf("a stopped edit still uploads: %q", got)
	}
}

func TestEditStartRefusesBadInput(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := realSession(t, h, map[string]string{"/f.txt": "x"})
	local := localFiles(t, "f.txt")[0]
	for name, c := range map[string][2]string{
		"relative remote": {"f.txt", local},
		"relative local":  {"/f.txt", "f.txt"},
		"missing remote":  {"/nope.txt", local},
		"missing local":   {"/f.txt", filepath.Join(t.TempDir(), "nope")},
	} {
		if err := h.app.Sftp.EditStart(sid, c[0], c[1]); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}
