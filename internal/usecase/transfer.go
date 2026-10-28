package usecase

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
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
}

// safeName refuses names a hostile server could use to escape the destination folder.
func safeName(n string) bool {
	return n != "" && n != "." && n != ".." && !strings.ContainsAny(n, "/\\\x00")
}

func isExists(err error) bool { return err != nil && strings.Contains(err.Error(), "already exists") }

func newResult() TransferResult { return TransferResult{Skipped: []string{}, Ignored: []string{}} }

// UploadAll sends files and folders (with everything inside) into remoteDir. Folders merge with ones that
// already exist; files that exist are skipped unless overwrite is true.
func (s *SftpService) UploadAll(sid string, locals []string, remoteDir string, overwrite bool) (TransferResult, error) {
	res := newResult()
	x, err := s.get(sid)
	if err != nil {
		return res, err
	}
	if len(locals) == 0 {
		return res, errors.New("nothing to upload")
	}
	jobs, err := planUpload(locals, remoteDir, &res)
	if err != nil {
		return res, err
	}
	var total int64
	for _, j := range jobs {
		total += j.size
	}
	var done int64
	prog := s.batchProgress(sid, "upload", &total)
	for _, j := range jobs {
		if j.dir {
			if err := mkdirExisting(x.fs.Mkdir, func(p string) error { _, err := x.fs.List(p); return err }, j.dst); err != nil {
				return res, fmt.Errorf("%s: %w", j.rel, err)
			}
			res.Dirs++
			continue
		}
		base := done
		err := x.fs.Upload(j.src, j.dst, overwrite, func(d, _ int64) { prog(j.rel, base+d) })
		switch {
		case isExists(err):
			res.Skipped = append(res.Skipped, j.rel)
		case err != nil:
			return res, fmt.Errorf("%s: %w", j.rel, err)
		default:
			res.Files++
			res.Bytes += j.size
		}
		done += j.size
		prog(j.rel, done)
	}
	return res, nil
}

// DownloadAll saves remote files and folders into localDir. Names come from the server, so each one is
// checked before it becomes a local path.
func (s *SftpService) DownloadAll(sid string, remotes []string, localDir string, overwrite bool) (TransferResult, error) {
	res := newResult()
	x, err := s.get(sid)
	if err != nil {
		return res, err
	}
	if len(remotes) == 0 {
		return res, errors.New("nothing to download")
	}
	if !filepath.IsAbs(localDir) || strings.ContainsRune(localDir, 0) {
		return res, errors.New("the local folder must be an absolute path")
	}
	jobs, err := planDownload(x.fs, remotes, filepath.Clean(localDir), &res)
	if err != nil {
		return res, err
	}
	var total int64
	for _, j := range jobs {
		total += j.size
	}
	var done int64
	prog := s.batchProgress(sid, "download", &total)
	for _, j := range jobs {
		if j.dir {
			if err := os.MkdirAll(j.dst, 0o755); err != nil {
				return res, fmt.Errorf("%s: %w", j.rel, err)
			}
			res.Dirs++
			continue
		}
		if _, err := os.Lstat(j.dst); err == nil && !overwrite {
			res.Skipped = append(res.Skipped, j.rel)
			done += j.size
			continue
		}
		base := done
		err := x.fs.Download(j.src, j.dst, overwrite, func(d, _ int64) { prog(j.rel, base+d) })
		switch {
		case isExists(err):
			res.Skipped = append(res.Skipped, j.rel)
		case err != nil:
			return res, fmt.Errorf("%s: %w", j.rel, err)
		default:
			res.Files++
			res.Bytes += j.size
		}
		done += j.size
		prog(j.rel, done)
	}
	return res, nil
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
