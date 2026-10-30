package usecase

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"vvterm/internal/domain"
)

// How many queued transfers run at the same time on one SFTP session.
const maxParallelJobs = 2

// Job states. A paused job keeps how far it got and continues from there; a failed or cancelled one can be
// retried and does the same.
const (
	jobQueued    = "queued"
	jobPreparing = "preparing"
	jobRunning   = "running"
	jobPaused    = "paused"
	jobDone      = "done"
	jobFailed    = "failed"
	jobCanceled  = "canceled"
)

var (
	errPaused  = errors.New("paused")
	errClosing = errors.New("connection lost")
)

// QueueSpec asks for one transfer. For upload the sources are local paths and destDir a remote folder; for
// download the sources are remote paths and destDir a local folder. A sync (sync-up, sync-down) takes one
// source folder and compares its contents with destDir: files that are new or changed are copied, nothing
// is ever deleted.
type QueueSpec struct {
	Direction string   `json:"direction"` // upload, download, sync-up, sync-down
	Sources   []string `json:"sources"`
	DestDir   string   `json:"destDir"`
	Overwrite bool     `json:"overwrite"`
}

// QueueJob is what the screens see of a queued transfer.
type QueueJob struct {
	ID        string   `json:"id"`
	Direction string   `json:"direction"`
	Name      string   `json:"name"`
	DestDir   string   `json:"destDir"`
	State     string   `json:"state"`
	Current   string   `json:"current"` // the file being copied
	Done      int64    `json:"done"`
	Total     int64    `json:"total"`
	Files     int      `json:"files"`
	Dirs      int      `json:"dirs"`
	Bytes     int64    `json:"bytes"`
	Skipped   []string `json:"skipped"`
	Ignored   []string `json:"ignored"`
	Error     string   `json:"error"`
}

type queueEntry struct {
	QueueJob // the part the screens see; guarded by transferQueue.mu
	spec     QueueSpec
	plan     []job
	planned  bool
	st       execState
	ctx      context.Context
	cancel   context.CancelCauseFunc // set while the job runs
}

// transferQueue runs the transfers of one SFTP session in the background, maxParallelJobs at a time, and
// publishes the whole list as sftp:queue:<sid> whenever it changes.
type transferQueue struct {
	s   *SftpService
	sid string
	x   *sftpSession

	mu       sync.Mutex
	jobs     []*queueEntry
	running  int
	lastEmit time.Time
	closed   bool
}

func newTransferQueue(s *SftpService, sid string, x *sftpSession) *transferQueue {
	return &transferQueue{s: s, sid: sid, x: x}
}

func validDirection(d string) bool {
	return d == "upload" || d == "download" || d == "sync-up" || d == "sync-down"
}

func isSync(d string) bool { return d == "sync-up" || d == "sync-down" }

func (q *transferQueue) enqueue(spec QueueSpec) (string, error) {
	if !validDirection(spec.Direction) {
		return "", fmt.Errorf("unknown transfer %q", spec.Direction)
	}
	if len(spec.Sources) == 0 {
		return "", errors.New("nothing to transfer")
	}
	if isSync(spec.Direction) && len(spec.Sources) != 1 {
		return "", errors.New("a sync takes one folder")
	}
	if spec.DestDir == "" {
		return "", errors.New("the destination folder is missing")
	}
	var name string
	switch {
	case isSync(spec.Direction):
		name = "Sync " + baseOf(spec.Sources[0])
	case len(spec.Sources) == 1:
		name = baseOf(spec.Sources[0])
	default:
		name = fmt.Sprintf("%d items", len(spec.Sources))
	}
	e := &queueEntry{spec: spec}
	e.QueueJob = QueueJob{ID: domain.NewID(), Direction: spec.Direction, Name: name, DestDir: spec.DestDir, State: jobQueued,
		Skipped: []string{}, Ignored: []string{}}
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return "", errors.New("the SFTP session is closed: reconnect")
	}
	q.jobs = append(q.jobs, e)
	q.mu.Unlock()
	q.publish(true)
	q.pump()
	return e.ID, nil
}

// baseOf is the last element of a local or remote path.
func baseOf(p string) string {
	p = strings.TrimRight(p, `/\`)
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		p = p[i+1:]
	}
	if p == "" {
		return "/"
	}
	return p
}

// pump starts queued jobs while there is room.
func (q *transferQueue) pump() {
	q.mu.Lock()
	var start []*queueEntry
	for _, e := range q.jobs {
		if q.closed || q.running >= maxParallelJobs {
			break
		}
		if e.State == jobQueued {
			e.State = jobPreparing
			e.ctx, e.cancel = context.WithCancelCause(context.Background()) // set now so a Pause or Cancel right away is not lost
			q.running++
			start = append(start, e)
		}
	}
	q.mu.Unlock()
	if len(start) > 0 {
		q.publish(true)
	}
	for _, e := range start {
		go q.run(e)
	}
}

func (q *transferQueue) run(e *queueEntry) {
	ctx, cancel := e.ctx, e.cancel
	defer cancel(nil)

	err := q.runJob(ctx, e)

	q.mu.Lock()
	e.cancel, e.ctx = nil, nil
	q.running--
	cause := context.Cause(ctx)
	switch {
	case err == nil:
		e.State = jobDone
		e.Current = ""
	case errors.Is(cause, errPaused):
		e.State = jobPaused
	case errors.Is(cause, domain.ErrTransferDiscarded):
		e.State = jobCanceled
		e.Current = ""
	default:
		e.State = jobFailed
		e.Error = err.Error()
		if errors.Is(cause, errClosing) {
			e.Error = errClosing.Error()
		}
	}
	state, msg := e.State, e.Error
	q.mu.Unlock()
	q.publish(true)
	switch state {
	case jobDone:
		q.s.logTransfer(q.x, verbFor(e.spec.Direction), e.spec.Direction, e.st.res, e.spec.DestDir, nil)
	case jobFailed:
		q.s.logTransfer(q.x, verbFor(e.spec.Direction), e.spec.Direction, TransferResult{}, e.spec.DestDir, errors.New(msg))
	}
	q.pump()
}

func verbFor(direction string) string {
	if direction == "download" || direction == "sync-down" {
		return "Saved"
	}
	return "Uploaded"
}

func (q *transferQueue) runJob(ctx context.Context, e *queueEntry) error {
	x := q.x
	if !e.planned {
		res := newResult()
		jobs, err := q.plan(e.spec, &res)
		if err != nil {
			return err
		}
		q.mu.Lock()
		e.plan, e.planned = jobs, true
		e.st = execState{res: res}
		e.Total = totalSize(jobs)
		e.Ignored = res.Ignored
		q.mu.Unlock()
	}
	q.mu.Lock()
	e.State, e.Error = jobRunning, ""
	q.mu.Unlock()
	q.publish(true)
	prog := func(name string, done int64) {
		q.mu.Lock()
		e.Current, e.Done = name, done
		q.mu.Unlock()
		q.publish(false)
	}
	step := func() {
		q.mu.Lock()
		e.Files, e.Dirs, e.Bytes = e.st.res.Files, e.st.res.Dirs, e.st.res.Bytes
		e.Skipped = e.st.res.Skipped
		q.mu.Unlock()
	}
	// a sync shows what it will replace before it starts: the files it lists are the ones to write
	return x.execute(ctx, e.spec.Direction, e.plan, e.spec.Overwrite || isSync(e.spec.Direction), &e.st, prog, step)
}

// plan lists what a job has to do. It runs in the background: a big folder takes a while to walk.
func (q *transferQueue) plan(spec QueueSpec, res *TransferResult) ([]job, error) {
	x := q.x
	switch spec.Direction {
	case "upload":
		return planUpload(spec.Sources, spec.DestDir, res)
	case "download":
		if !filepath.IsAbs(spec.DestDir) || strings.ContainsRune(spec.DestDir, 0) {
			return nil, errors.New("the local folder must be an absolute path")
		}
		return planDownload(x.fs, spec.Sources, filepath.Clean(spec.DestDir), res)
	default:
		_, jobs, err := planSync(x.fs, spec.Direction, spec.Sources[0], spec.DestDir, res)
		return jobs, err
	}
}

// publish sends the list. Progress is throttled; a change of state is always sent.
func (q *transferQueue) publish(force bool) {
	q.mu.Lock()
	if q.closed && !force {
		q.mu.Unlock()
		return
	}
	if now := time.Now(); !force && now.Sub(q.lastEmit) < 100*time.Millisecond {
		q.mu.Unlock()
		return
	} else {
		q.lastEmit = now
	}
	snap := q.snapshotLocked()
	q.mu.Unlock()
	q.s.c.emit("sftp:queue:"+q.sid, snap)
}

func (q *transferQueue) snapshotLocked() []QueueJob {
	out := make([]QueueJob, 0, len(q.jobs))
	for _, e := range q.jobs {
		j := e.QueueJob
		j.Skipped = append([]string{}, j.Skipped...)
		j.Ignored = append([]string{}, j.Ignored...)
		out = append(out, j)
	}
	return out
}

func (q *transferQueue) snapshot() []QueueJob {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.snapshotLocked()
}

func (q *transferQueue) find(id string) *queueEntry {
	for _, e := range q.jobs {
		if e.ID == id {
			return e
		}
	}
	return nil
}

// pause stops a running job (keeping the partial file) or holds back a queued one.
func (q *transferQueue) pause(id string) error {
	q.mu.Lock()
	e := q.find(id)
	if e == nil {
		q.mu.Unlock()
		return errors.New("no such transfer")
	}
	switch e.State {
	case jobQueued:
		e.State = jobPaused
	case jobPreparing, jobRunning:
		if e.cancel != nil {
			e.cancel(errPaused)
		}
	default:
		q.mu.Unlock()
		return nil
	}
	q.mu.Unlock()
	q.publish(true)
	return nil
}

// resume puts a paused job back in line; retry does the same for one that failed or was cancelled. Either
// continues with the file it stopped in, from the bytes already copied.
func (q *transferQueue) requeue(id string, from ...string) error {
	q.mu.Lock()
	e := q.find(id)
	if e == nil {
		q.mu.Unlock()
		return errors.New("no such transfer")
	}
	ok := false
	for _, s := range from {
		ok = ok || e.State == s
	}
	if !ok {
		q.mu.Unlock()
		return nil
	}
	e.State, e.Error = jobQueued, ""
	q.mu.Unlock()
	q.publish(true)
	q.pump()
	return nil
}

// cancel ends a job for good and deletes its partial file.
func (q *transferQueue) cancelJob(id string) error {
	q.mu.Lock()
	e := q.find(id)
	if e == nil {
		q.mu.Unlock()
		return errors.New("no such transfer")
	}
	var leftover *queueEntry
	switch e.State {
	case jobPreparing, jobRunning:
		if e.cancel != nil {
			e.cancel(domain.ErrTransferDiscarded)
		}
	case jobQueued, jobPaused:
		e.State = jobCanceled
		e.Current = ""
		if e.planned {
			leftover = e
		}
	default:
		q.mu.Unlock()
		return nil
	}
	q.mu.Unlock()
	q.publish(true)
	if leftover != nil {
		go q.discardPartial(leftover)
	}
	return nil
}

// discardPartial removes the partial copy of the file a paused job stopped in, by running that one copy with a
// context that is already cancelled for good.
func (q *transferQueue) discardPartial(e *queueEntry) {
	if e.st.next >= len(e.plan) {
		return
	}
	j := e.plan[e.st.next]
	if j.dir {
		return
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(domain.ErrTransferDiscarded)
	if e.spec.Direction == "upload" || e.spec.Direction == "sync-up" {
		_ = q.x.fs.Upload(ctx, j.src, j.dst, true, nil)
	} else if _, err := os.Lstat(j.dst); err != nil {
		_ = q.x.fs.Download(ctx, j.src, j.dst, true, nil)
	}
}

func (q *transferQueue) clearFinished() {
	q.mu.Lock()
	kept := q.jobs[:0]
	for _, e := range q.jobs {
		if e.State != jobDone && e.State != jobFailed && e.State != jobCanceled {
			kept = append(kept, e)
		}
	}
	q.jobs = kept
	q.mu.Unlock()
	q.publish(true)
}

// closeAll stops everything: the connection is gone or the app is closing.
func (q *transferQueue) closeAll() {
	q.mu.Lock()
	q.closed = true
	for _, e := range q.jobs {
		if e.cancel != nil {
			e.cancel(errClosing)
		}
	}
	q.mu.Unlock()
}

// ---- the SftpService calls ----

// Enqueue starts a transfer in the background and returns its id. It returns at once; watch sftp:queue:<sid>.
func (s *SftpService) Enqueue(sid string, spec QueueSpec) (string, error) {
	x, err := s.get(sid)
	if err != nil {
		return "", err
	}
	return x.q.enqueue(spec)
}

// Queue lists the transfers of a session, oldest first.
func (s *SftpService) Queue(sid string) ([]QueueJob, error) {
	x, err := s.get(sid)
	if err != nil {
		return nil, err
	}
	return x.q.snapshot(), nil
}

// Pause stops a transfer where it is; Resume continues it from there.
func (s *SftpService) Pause(sid, id string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.q.pause(id)
}

func (s *SftpService) Resume(sid, id string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.q.requeue(id, jobPaused)
}

// Retry starts a failed or cancelled transfer again, continuing a partial file.
func (s *SftpService) Retry(sid, id string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.q.requeue(id, jobFailed, jobCanceled)
}

// Cancel ends a transfer for good and deletes the partial file it left.
func (s *SftpService) Cancel(sid, id string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.q.cancelJob(id)
}

// ClearFinished drops the transfers that are done, failed or cancelled from the list.
func (s *SftpService) ClearFinished(sid string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	x.q.clearFinished()
	return nil
}

// Conflicts lists the names (relative to destDir) that a transfer would replace: the ones that already exist
// at the destination. The screen asks once, then enqueues with or without overwrite.
func (s *SftpService) Conflicts(sid, direction string, sources []string, destDir string) ([]string, error) {
	x, err := s.get(sid)
	if err != nil {
		return nil, err
	}
	res := newResult()
	out := []string{}
	switch direction {
	case "upload":
		jobs, err := planUpload(sources, destDir, &res)
		if err != nil {
			return nil, err
		}
		listed := map[string]map[string]bool{}
		for _, j := range jobs {
			if j.dir {
				continue
			}
			dir := path.Dir(j.dst)
			names, ok := listed[dir]
			if !ok {
				names = map[string]bool{}
				if entries, err := x.fs.List(dir); err == nil { // a folder that is not there yet has no conflicts
					for _, e := range entries {
						names[e.Name] = true
					}
				}
				listed[dir] = names
			}
			if names[path.Base(j.dst)] {
				out = append(out, j.rel)
			}
		}
	case "download":
		if !filepath.IsAbs(destDir) || strings.ContainsRune(destDir, 0) {
			return nil, errors.New("the local folder must be an absolute path")
		}
		jobs, err := planDownload(x.fs, sources, filepath.Clean(destDir), &res)
		if err != nil {
			return nil, err
		}
		for _, j := range jobs {
			if j.dir {
				continue
			}
			if _, err := os.Lstat(j.dst); err == nil {
				out = append(out, j.rel)
			}
		}
	default:
		return nil, fmt.Errorf("unknown transfer %q", direction)
	}
	return out, nil
}
