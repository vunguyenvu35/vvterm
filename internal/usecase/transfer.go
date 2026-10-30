package usecase

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"vvterm/internal/domain"
)

// Limits that keep one drag from running away with a whole disk or a hostile server's endless listing.
const (
	maxTransferItems = 100_000
	maxTransferDepth = 64
)

// TransferResult says what a multi-file transfer did. Existing files are left alone unless overwrite was
// asked for, and are listed in Skipped so the UI can ask once.
type TransferResult struct {
	Files   int      `json:"files"`
	Dirs    int      `json:"dirs"`
	Bytes   int64    `json:"bytes"`
	Skipped []string `json:"skipped"` // files that already exist and were not replaced
	Ignored []string `json:"ignored"` // symbolic links and special files: never followed
}

type job struct {
	dir  bool
	src  string
	dst  string
	rel  string // shown to the user, relative to the folder that was dragged
	size int64
	// quiet: a folder that is only made sure of (the target of a sync), not counted as one made
	quiet bool
}

// safeName refuses names a hostile server could use to escape the destination folder.
func safeName(n string) bool {
	return n != "" && n != "." && n != ".." && !strings.ContainsAny(n, "/\\\x00")
}

func isExists(err error) bool { return err != nil && strings.Contains(err.Error(), "already exists") }

func newResult() TransferResult { return TransferResult{Skipped: []string{}, Ignored: []string{}} }

// execState is how far a plan has got. A transfer that is paused or fails keeps it, so it continues with the
// file it stopped in (whose partial copy is continued too) and does not start over.
type execState struct {
	next int   // index of the next job to run
	done int64 // bytes of the files finished so far
	res  TransferResult
}

// execute runs jobs[st.next:] in order. A cancelled ctx stops it with the context's cause. step is told after
// every finished job, prog while a file is copied.
func (x *sftpSession) execute(ctx context.Context, direction string, jobs []job, overwrite bool, st *execState, prog func(name string, done int64), step func()) error {
	upload := direction == "upload" || direction == "sync-up"
	for ; st.next < len(jobs); st.next++ {
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		j := jobs[st.next]
		if j.dir {
			var err error
			if upload {
				err = mkdirExisting(x.fs.Mkdir, func(p string) error { _, err := x.fs.List(p); return err }, j.dst)
			} else {
				err = os.MkdirAll(j.dst, 0o755)
			}
			if err != nil {
				return fmt.Errorf("%s: %w", j.rel, err)
			}
			if !j.quiet {
				st.res.Dirs++
			}
			step()
			continue
		}
		if !upload && !overwrite {
			if _, err := os.Lstat(j.dst); err == nil {
				st.res.Skipped = append(st.res.Skipped, j.rel)
				st.done += j.size
				step()
				continue
			}
		}
		base := st.done
		report := func(d, _ int64) { prog(j.rel, base+d) }
		var err error
		if upload {
			err = x.fs.Upload(ctx, j.src, j.dst, overwrite, report)
		} else {
			err = x.fs.Download(ctx, j.src, j.dst, overwrite, report)
		}
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		switch {
		case isExists(err):
			st.res.Skipped = append(st.res.Skipped, j.rel)
		case err != nil:
			return fmt.Errorf("%s: %w", j.rel, err)
		default:
			st.res.Files++
			st.res.Bytes += j.size
		}
		st.done += j.size
		prog(j.rel, st.done)
		step()
	}
	return nil
}

func totalSize(jobs []job) (n int64) {
	for _, j := range jobs {
		n += j.size
	}
	return n
}

// UploadAll sends files and folders (with everything inside) into remoteDir and waits until they are there.
// Folders merge with ones that already exist; files that exist are skipped unless overwrite is true. The
// screens use Enqueue instead, which runs the same plan in the background.
func (s *SftpService) UploadAll(sid string, locals []string, remoteDir string, overwrite bool) (res TransferResult, err error) {
	return s.runNow(sid, "upload", "Uploaded", remoteDir, overwrite, func(x *sftpSession, res *TransferResult) ([]job, error) {
		if len(locals) == 0 {
			return nil, errors.New("nothing to upload")
		}
		return planUpload(locals, remoteDir, res)
	})
}

// DownloadAll saves remote files and folders into localDir. Names come from the server, so each one is
// checked before it becomes a local path.
func (s *SftpService) DownloadAll(sid string, remotes []string, localDir string, overwrite bool) (res TransferResult, err error) {
	return s.runNow(sid, "download", "Saved", localDir, overwrite, func(x *sftpSession, res *TransferResult) ([]job, error) {
		if len(remotes) == 0 {
			return nil, errors.New("nothing to download")
		}
		if !filepath.IsAbs(localDir) || strings.ContainsRune(localDir, 0) {
			return nil, errors.New("the local folder must be an absolute path")
		}
		return planDownload(x.fs, remotes, filepath.Clean(localDir), res)
	})
}

func (s *SftpService) runNow(sid, direction, verb, where string, overwrite bool, plan func(*sftpSession, *TransferResult) ([]job, error)) (res TransferResult, err error) {
	res = newResult()
	x, err := s.get(sid)
	if err != nil {
		return res, err
	}
	defer func() { s.logTransfer(x, verb, direction, res, where, err) }()
	jobs, err := plan(x, &res)
	if err != nil {
		return res, err
	}
	total := totalSize(jobs)
	prog := s.batchProgress(sid, direction, &total)
	st := execState{res: res}
	err = x.execute(context.Background(), direction, jobs, overwrite, &st, prog, func() {})
	return st.res, err
}

// batchProgress emits one progress stream for the whole batch: the file being worked on, and bytes done
// of the bytes in total.
func (s *SftpService) batchProgress(sid, direction string, total *int64) func(name string, done int64) {
	var last time.Time
	return func(name string, done int64) {
		if now := time.Now(); done < *total && now.Sub(last) < 100*time.Millisecond {
			return
		} else {
			last = now
		}
		s.c.emit("sftp:progress:"+sid, map[string]any{"name": name, "direction": direction, "done": done, "total": *total})
	}
}

// mkdirExisting creates a remote folder, accepting that it may already be there.
func mkdirExisting(mkdir func(string) error, exists func(string) error, p string) error {
	if err := mkdir(p); err != nil {
		if lerr := exists(p); lerr != nil {
			return err // not there and could not be created
		}
	}
	return nil
}

func planUpload(locals []string, remoteDir string, res *TransferResult) ([]job, error) {
	var jobs []job
	count := 0
	for _, root := range locals {
		if !filepath.IsAbs(root) || strings.ContainsRune(root, 0) {
			return nil, fmt.Errorf("%q is not an absolute path", root)
		}
		root = filepath.Clean(root)
		name := filepath.Base(root)
		if !safeName(name) {
			return nil, fmt.Errorf("cannot upload %q", root)
		}
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(filepath.Dir(root), p)
			if count++; count > maxTransferItems {
				return fmt.Errorf("more than %d items: upload a smaller selection", maxTransferItems)
			}
			if strings.Count(rel, string(filepath.Separator)) > maxTransferDepth {
				return errors.New("folders are nested too deeply")
			}
			dst := path.Join(remoteDir, filepath.ToSlash(rel))
			switch {
			case d.Type()&fs.ModeSymlink != 0:
				res.Ignored = append(res.Ignored, filepath.ToSlash(rel))
			case d.IsDir():
				jobs = append(jobs, job{dir: true, src: p, dst: dst, rel: filepath.ToSlash(rel)})
			case d.Type().IsRegular():
				info, err := d.Info()
				if err != nil {
					return err
				}
				jobs = append(jobs, job{src: p, dst: dst, rel: filepath.ToSlash(rel), size: info.Size()})
			default:
				res.Ignored = append(res.Ignored, filepath.ToSlash(rel))
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return jobs, nil
}

func planDownload(rfs RemoteFS, remotes []string, localDir string, res *TransferResult) ([]job, error) {
	var jobs []job
	count := 0
	var walk func(src, dst, rel string, depth int) error
	walk = func(src, dst, rel string, depth int) error {
		if depth > maxTransferDepth {
			return errors.New("folders are nested too deeply")
		}
		entries, err := rfs.List(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if !safeName(e.Name) {
				res.Ignored = append(res.Ignored, path.Join(rel, e.Name)+" (unsafe name)")
				continue
			}
			if count++; count > maxTransferItems {
				return fmt.Errorf("more than %d items: download a smaller selection", maxTransferItems)
			}
			r := path.Join(rel, e.Name)
			d := filepath.Join(dst, e.Name)
			switch {
			case e.IsLink:
				res.Ignored = append(res.Ignored, r)
			case e.IsDir:
				jobs = append(jobs, job{dir: true, src: e.Path, dst: d, rel: r})
				if err := walk(e.Path, d, r, depth+1); err != nil {
					return err
				}
			default:
				jobs = append(jobs, job{src: e.Path, dst: d, rel: r, size: e.Size})
			}
		}
		return nil
	}
	for _, p := range remotes {
		if !path.IsAbs(p) || strings.ContainsRune(p, 0) || p == "/" {
			return nil, fmt.Errorf("cannot download %q", p)
		}
		p = path.Clean(p)
		name := path.Base(p)
		if !safeName(name) {
			return nil, fmt.Errorf("cannot download %q", p)
		}
		parent, err := rfs.List(path.Dir(p))
		if err != nil {
			return nil, err
		}
		var found bool
		for _, e := range parent {
			if e.Path != p {
				continue
			}
			found = true
			switch {
			case e.IsLink:
				res.Ignored = append(res.Ignored, name)
			case e.IsDir:
				jobs = append(jobs, job{dir: true, src: p, dst: filepath.Join(localDir, name), rel: name})
				if err := walk(p, filepath.Join(localDir, name), name, 1); err != nil {
					return nil, err
				}
			default:
				jobs = append(jobs, job{src: p, dst: filepath.Join(localDir, name), rel: name, size: e.Size})
			}
		}
		if !found {
			return nil, fmt.Errorf("%s: no such file or folder", p)
		}
	}
	return jobs, nil
}

// logTransfer writes one line per batch: what moved, or why it stopped.
func (s *SftpService) logTransfer(x *sftpSession, verb, direction string, res TransferResult, where string, err error) {
	if err != nil {
		s.c.record(domain.ActTransfer, x.hostID, x.label, fmt.Sprintf("%s failed: %v", strings.ToUpper(direction[:1])+direction[1:], err), false)
		return
	}
	prep := "to"
	if direction == "download" {
		prep = "into"
	}
	s.c.record(domain.ActTransfer, x.hostID, x.label, summarizeTransfer(verb, res, prep+" "+where), true)
}
