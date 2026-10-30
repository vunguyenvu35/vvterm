package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vvterm/internal/domain"
)

// gateFS is a remote file system whose uploads can be held, so a test decides when a copy is in flight.
type gateFS struct {
	*fakeRemote
	gmu     sync.Mutex
	calls   []string
	causes  []error
	started chan string
	release chan struct{}
	block   bool
	failOn  map[string]error // remote path -> error, returned once
}

func newGateFS(block bool) *gateFS {
	return &gateFS{fakeRemote: &fakeRemote{}, started: make(chan string, 64), release: make(chan struct{}, 64), block: block, failOn: map[string]error{}}
}

func (g *gateFS) Upload(ctx context.Context, l, r string, o bool, p func(int64, int64)) error {
	g.gmu.Lock()
	g.calls = append(g.calls, r)
	fail := g.failOn[r]
	delete(g.failOn, r)
	g.gmu.Unlock()
	g.started <- r
	if fail != nil {
		return fail
	}
	if !g.block {
		return nil
	}
	select {
	case <-ctx.Done():
		g.gmu.Lock()
		g.causes = append(g.causes, context.Cause(ctx))
		g.gmu.Unlock()
		return context.Cause(ctx)
	case <-g.release:
		return nil
	}
}

func (g *gateFS) callsTo(r string) (n int) {
	g.gmu.Lock()
	defer g.gmu.Unlock()
	for _, c := range g.calls {
		if c == r {
			n++
		}
	}
	return n
}

func (g *gateFS) lastCause() error {
	g.gmu.Lock()
	defer g.gmu.Unlock()
	if len(g.causes) == 0 {
		return nil
	}
	return g.causes[len(g.causes)-1]
}

// gateSession puts a session on the fake file system straight into the service.
func gateSession(t *testing.T, h *harness, g *gateFS) string {
	t.Helper()
	x := &sftpSession{hostID: "h", label: "gate", fs: g, stop: make(chan struct{})}
	sid := "gate-" + domain.NewID()
	x.q = newTransferQueue(h.app.Sftp, sid, x)
	x.edits = newEditWatches(h.app.Sftp, sid, x)
	h.app.Sftp.mu.Lock()
	h.app.Sftp.sessions[sid] = x
	h.app.Sftp.mu.Unlock()
	t.Cleanup(x.q.closeAll)
	return sid
}

func localFiles(t *testing.T, names ...string) []string {
	t.Helper()
	dir := t.TempDir()
	var out []string
	for _, n := range names {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("data of "+n), 0o600); err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func jobOf(t *testing.T, h *harness, sid, id string) QueueJob {
	t.Helper()
	q, err := h.app.Sftp.Queue(sid)
	if err != nil {
		t.Fatal(err)
	}
	for _, j := range q {
		if j.ID == id {
			return j
		}
	}
	t.Fatalf("job %s not in the queue: %+v", id, q)
	return QueueJob{}
}

func waitState(t *testing.T, h *harness, sid, id string, states ...string) QueueJob {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		j := jobOf(t, h, sid, id)
		for _, s := range states {
			if j.State == s {
				return j
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("job still %q (error %q), wanted %v", j.State, j.Error, states)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func waitStarted(t *testing.T, g *gateFS) string {
	t.Helper()
	select {
	case r := <-g.started:
		return r
	case <-time.After(10 * time.Second):
		t.Fatal("no upload started")
		return ""
	}
}

func enqueueUpload(t *testing.T, h *harness, sid string, locals []string, dir string) string {
	t.Helper()
	id, err := h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "upload", Sources: locals, DestDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestQueuePauseContinuesWhereItStopped(t *testing.T) {
	h := newHarness(t).unlocked(t)
	g := newGateFS(true)
	sid := gateSession(t, h, g)
	id := enqueueUpload(t, h, sid, localFiles(t, "a.txt", "b.txt"), "/up")
	if r := waitStarted(t, g); r != "/up/a.txt" {
		t.Fatalf("first file: %s", r)
	}
	if err := h.app.Sftp.Pause(sid, id); err != nil {
		t.Fatal(err)
	}
	waitState(t, h, sid, id, "paused")
	if err := h.app.Sftp.Resume(sid, id); err != nil {
		t.Fatal(err)
	}
	if r := waitStarted(t, g); r != "/up/a.txt" {
		t.Fatalf("a resumed job continues with the file it stopped in, got %s", r)
	}
	g.release <- struct{}{}
	if r := waitStarted(t, g); r != "/up/b.txt" {
		t.Fatalf("second file: %s", r)
	}
	g.release <- struct{}{}
	j := waitState(t, h, sid, id, "done")
	if j.Files != 2 || j.Total == 0 || j.Done != j.Total {
		t.Fatalf("%+v", j)
	}
	if g.callsTo("/up/a.txt") != 2 || g.callsTo("/up/b.txt") != 1 {
		t.Fatalf("calls: %v", g.calls)
	}
	if err := g.causes[0]; !errors.Is(err, errPaused) {
		t.Fatalf("a pause must not ask to delete the partial file, cause %v", err)
	}
}

func TestQueueCancelDiscardsAndRetryStartsAgain(t *testing.T) {
	h := newHarness(t).unlocked(t)
	g := newGateFS(true)
	sid := gateSession(t, h, g)
	id := enqueueUpload(t, h, sid, localFiles(t, "a.txt"), "/up")
	waitStarted(t, g)
	if err := h.app.Sftp.Cancel(sid, id); err != nil {
		t.Fatal(err)
	}
	waitState(t, h, sid, id, "canceled")
	if !errors.Is(g.lastCause(), domain.ErrTransferDiscarded) {
		t.Fatalf("a cancel deletes the partial file, cause %v", g.lastCause())
	}
	if err := h.app.Sftp.Retry(sid, id); err != nil {
		t.Fatal(err)
	}
	waitStarted(t, g)
	g.release <- struct{}{}
	waitState(t, h, sid, id, "done")
}

func TestQueueCancelOfAPausedJobRemovesItsPartialFile(t *testing.T) {
	h := newHarness(t).unlocked(t)
	g := newGateFS(true)
	sid := gateSession(t, h, g)
	id := enqueueUpload(t, h, sid, localFiles(t, "a.txt"), "/up")
	waitStarted(t, g)
	_ = h.app.Sftp.Pause(sid, id)
	waitState(t, h, sid, id, "paused")
	if err := h.app.Sftp.Cancel(sid, id); err != nil {
		t.Fatal(err)
	}
	waitState(t, h, sid, id, "canceled")
	waitStarted(t, g) // the clean-up copy, run with a context that is already cancelled for good
	deadline := time.Now().Add(5 * time.Second)
	for !errors.Is(g.lastCause(), domain.ErrTransferDiscarded) {
		if time.Now().After(deadline) {
			t.Fatalf("no discard of the partial file, cause %v", g.lastCause())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestQueueFailureKeepsProgressAndRetryContinues(t *testing.T) {
	h := newHarness(t).unlocked(t)
	g := newGateFS(false)
	g.failOn["/up/b.txt"] = errors.New("broken pipe")
	sid := gateSession(t, h, g)
	id := enqueueUpload(t, h, sid, localFiles(t, "a.txt", "b.txt", "c.txt"), "/up")
	j := waitState(t, h, sid, id, "failed")
	if !strings.Contains(j.Error, "b.txt") || !strings.Contains(j.Error, "broken pipe") || j.Files != 1 {
		t.Fatalf("%+v", j)
	}
	if err := h.app.Sftp.Retry(sid, id); err != nil {
		t.Fatal(err)
	}
	j = waitState(t, h, sid, id, "done")
	if j.Files != 3 || j.Error != "" {
		t.Fatalf("%+v", j)
	}
	if g.callsTo("/up/a.txt") != 1 || g.callsTo("/up/b.txt") != 2 || g.callsTo("/up/c.txt") != 1 {
		t.Fatalf("a finished file must not be copied again: %v", g.calls)
	}
}

func TestQueueRunsTwoAtATime(t *testing.T) {
	h := newHarness(t).unlocked(t)
	g := newGateFS(true)
	sid := gateSession(t, h, g)
	var ids []string
	for _, n := range []string{"a.txt", "b.txt", "c.txt"} {
		ids = append(ids, enqueueUpload(t, h, sid, localFiles(t, n), "/up"))
	}
	waitStarted(t, g)
	waitStarted(t, g)
	time.Sleep(50 * time.Millisecond)
	if st := jobOf(t, h, sid, ids[2]).State; st != "queued" {
		t.Fatalf("third job is %q, wanted queued", st)
	}
	g.release <- struct{}{}
	waitStarted(t, g) // the third starts when a place is free
	g.release <- struct{}{}
	g.release <- struct{}{}
	for _, id := range ids {
		waitState(t, h, sid, id, "done")
	}
}

func TestQueueClearFinishedKeepsTheRest(t *testing.T) {
	h := newHarness(t).unlocked(t)
	g := newGateFS(false)
	sid := gateSession(t, h, g)
	done := enqueueUpload(t, h, sid, localFiles(t, "a.txt"), "/up")
	waitState(t, h, sid, done, "done")
	g.block = true
	busy := enqueueUpload(t, h, sid, localFiles(t, "b.txt"), "/up")
	waitStarted(t, g)
	waitStarted(t, g)
	if err := h.app.Sftp.ClearFinished(sid); err != nil {
		t.Fatal(err)
	}
	q, _ := h.app.Sftp.Queue(sid)
	if len(q) != 1 || q[0].ID != busy {
		t.Fatalf("%+v", q)
	}
}

func TestQueuePausedBeforeItStartsAndEventsCarryTheList(t *testing.T) {
	h := newHarness(t).unlocked(t)
	g := newGateFS(true)
	sid := gateSession(t, h, g)
	a := enqueueUpload(t, h, sid, localFiles(t, "a.txt"), "/up")
	b := enqueueUpload(t, h, sid, localFiles(t, "b.txt"), "/up")
	c := enqueueUpload(t, h, sid, localFiles(t, "c.txt"), "/up")
	waitStarted(t, g)
	waitStarted(t, g)
	if err := h.app.Sftp.Pause(sid, c); err != nil { // still queued
		t.Fatal(err)
	}
	if st := jobOf(t, h, sid, c).State; st != "paused" {
		t.Fatalf("%s", st)
	}
	g.release <- struct{}{}
	g.release <- struct{}{}
	waitState(t, h, sid, a, "done")
	waitState(t, h, sid, b, "done")
	time.Sleep(50 * time.Millisecond)
	if st := jobOf(t, h, sid, c).State; st != "paused" {
		t.Fatalf("a paused job must not start by itself, it is %s", st)
	}
	last, ok := h.rec.lastEvent("sftp:queue:" + sid).data.([]QueueJob)
	if !ok || len(last) != 3 {
		t.Fatalf("queue event: %#v", h.rec.lastEvent("sftp:queue:"+sid).data)
	}
}

func TestQueueClosingTheSessionStopsRunningJobs(t *testing.T) {
	h := newHarness(t).unlocked(t)
	g := newGateFS(true)
	sid := gateSession(t, h, g)
	id := enqueueUpload(t, h, sid, localFiles(t, "a.txt"), "/up")
	waitStarted(t, g)
	x, _ := h.app.Sftp.get(sid)
	x.q.closeAll()
	j := waitState(t, h, sid, id, "failed")
	if j.Error != "connection lost" {
		t.Fatalf("%+v", j)
	}
	if _, err := h.app.Sftp.Enqueue(sid, QueueSpec{Direction: "upload", Sources: localFiles(t, "x"), DestDir: "/up"}); err == nil {
		t.Fatal("a closed queue accepted a job")
	}
}

func TestEnqueueRefusesNonsense(t *testing.T) {
	h := newHarness(t).unlocked(t)
	sid := gateSession(t, h, newGateFS(false))
	files := localFiles(t, "a.txt")
	for name, spec := range map[string]QueueSpec{
		"direction":   {Direction: "teleport", Sources: files, DestDir: "/x"},
		"no sources":  {Direction: "upload", DestDir: "/x"},
		"no dest":     {Direction: "upload", Sources: files},
		"sync of two": {Direction: "sync-up", Sources: append(files, files...), DestDir: "/x"},
	} {
		if _, err := h.app.Sftp.Enqueue(sid, spec); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := h.app.Sftp.Enqueue("nope", QueueSpec{}); err == nil {
		t.Error("unknown session accepted")
	}
	if err := h.app.Sftp.Pause(sid, "nope"); err == nil {
		t.Error("unknown job accepted")
	}
}
