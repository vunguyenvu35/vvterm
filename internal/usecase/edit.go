package usecase

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"
)

var (
	editPoll   = 700 * time.Millisecond // how often the local copy is looked at
	editSettle = 900 * time.Millisecond // how long it has to stay unchanged before it is sent (editors save in several steps)
)

// EditEvent tells the screen what happened to a file that is being edited: uploaded (saved back to the
// server), conflict (the server's copy changed since it was opened; nothing was sent) or error.
type EditEvent struct {
	Remote  string `json:"remote"`
	State   string `json:"state"`
	Message string `json:"message"`
}

type editWatch struct {
	remote, local string
	stop          chan struct{}

	mu         sync.Mutex // one upload at a time; guards the fields below
	baseSize   int64      // the server's copy as it was when it was opened or last saved by us
	baseMod    time.Time
	seenSize   int64 // the local copy as last looked at
	seenMod    time.Time
	conflicted bool // the last save was held back: wait for another change or an explicit push
}

type editWatches struct {
	s   *SftpService
	sid string
	x   *sftpSession

	mu sync.Mutex
	m  map[string]*editWatch
}

func newEditWatches(s *SftpService, sid string, x *sftpSession) *editWatches {
	return &editWatches{s: s, sid: sid, x: x, m: map[string]*editWatch{}}
}

func (w *editWatches) emit(remote, state, msg string) {
	w.s.c.emit("sftp:edit:"+w.sid, EditEvent{Remote: remote, State: state, Message: msg})
}

func (w *editWatches) start(remote, local string) error {
	if !path.IsAbs(remote) || !filepath.IsAbs(local) {
		return errors.New("paths must be absolute")
	}
	rst, err := w.x.fs.Stat(remote)
	if err != nil {
		return err
	}
	lst, err := os.Stat(local)
	if err != nil {
		return err
	}
	e := &editWatch{remote: path.Clean(remote), local: local, stop: make(chan struct{}),
		baseSize: rst.Size, baseMod: rst.ModTime, seenSize: lst.Size(), seenMod: lst.ModTime()}
	w.mu.Lock()
	if old := w.m[e.remote]; old != nil {
		close(old.stop)
	}
	w.m[e.remote] = e
	w.mu.Unlock()
	go w.watch(e)
	return nil
}

func (w *editWatches) watch(e *editWatch) {
	t := time.NewTicker(editPoll)
	defer t.Stop()
	var dirtySince time.Time
	for {
		select {
		case <-e.stop:
			return
		case <-w.x.stop:
			return
		case <-t.C:
		}
		st, err := os.Stat(e.local)
		if err != nil {
			continue // the editor is replacing the file
		}
		e.mu.Lock()
		changed := st.Size() != e.seenSize || !st.ModTime().Equal(e.seenMod)
		if changed {
			e.seenSize, e.seenMod = st.Size(), st.ModTime()
			e.conflicted = false
			dirtySince = time.Now()
		}
		e.mu.Unlock()
		if !dirtySince.IsZero() && time.Since(dirtySince) >= editSettle {
			dirtySince = time.Time{}
			_ = w.push(e, false)
		}
	}
}

// push sends the local copy to the server. Without force it holds back when the server's copy is not the one
// that was opened.
func (w *editWatches) push(e *editWatch, force bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	cur, err := w.x.fs.Stat(e.remote)
	if err != nil {
		w.emit(e.remote, "error", err.Error())
		return err
	}
	if !force && (cur.Size != e.baseSize || !cur.ModTime.Equal(e.baseMod)) {
		e.conflicted = true
		w.emit(e.remote, "conflict", fmt.Sprintf("%s changed on the server since it was opened", path.Base(e.remote)))
		return nil
	}
	if err := w.x.fs.Upload(context.Background(), e.local, e.remote, true, nil); err != nil {
		w.emit(e.remote, "error", err.Error())
		return err
	}
	if cur, err = w.x.fs.Stat(e.remote); err == nil {
		e.baseSize, e.baseMod = cur.Size, cur.ModTime
	}
	e.conflicted = false
	w.emit(e.remote, "uploaded", "")
	return nil
}

func (w *editWatches) get(remote string) (*editWatch, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if e := w.m[path.Clean(remote)]; e != nil {
		return e, nil
	}
	return nil, errors.New("that file is not being edited")
}

func (w *editWatches) stopOne(remote string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	remote = path.Clean(remote)
	if e := w.m[remote]; e != nil {
		close(e.stop)
		delete(w.m, remote)
	}
}

func (w *editWatches) stopAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for k, e := range w.m {
		close(e.stop)
		delete(w.m, k)
	}
}

// EditStart watches a local copy of a remote file (the screen has already downloaded and opened it): when it is
// saved, it is uploaded again. Events: sftp:edit:<sid>.
func (s *SftpService) EditStart(sid, remote, local string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.edits.start(remote, local)
}

// EditPush sends the local copy now. With force it replaces the server's copy even if that changed meanwhile
// (after the user confirmed a conflict).
func (s *SftpService) EditPush(sid, remote string, force bool) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	e, err := x.edits.get(remote)
	if err != nil {
		return err
	}
	return x.edits.push(e, force)
}

// EditStop stops watching a file.
func (s *SftpService) EditStop(sid, remote string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	x.edits.stopOne(remote)
	return nil
}
