package usecase

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// maxSyncExtra caps the list of files that exist only on the target; they are shown, never touched.
const maxSyncExtra = 200

// mtimeSlack is how much newer a source file has to be before it counts as changed when its size is the
// same: file systems and servers round times differently.
const mtimeSlack = 2 * time.Second

// SyncItem is one file a sync would copy.
type SyncItem struct {
	Path   string `json:"path"` // relative to the compared folders
	Size   int64  `json:"size"`
	Reason string `json:"reason"` // new, changed
}

// SyncDiff is what comparing two folders found: what a sync would copy, how many files are the same, and
// which files only the target has (a sync leaves those alone: it never deletes).
type SyncDiff struct {
	Copy  []SyncItem `json:"copy"`
	Same  int        `json:"same"`
	Extra []string   `json:"extra"`
}

type treeEntry struct {
	size int64
	mod  time.Time
	dir  bool
}

// localTree lists a local folder: relative path -> entry. Links and special files are left out.
func localTree(root string, res *TransferResult) (map[string]treeEntry, error) {
	out := map[string]treeEntry{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if len(out) >= maxTransferItems {
			return fmt.Errorf("more than %d items: sync a smaller folder", maxTransferItems)
		}
		if strings.Count(rel, "/") > maxTransferDepth {
			return errors.New("folders are nested too deeply")
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			res.Ignored = append(res.Ignored, rel)
		case d.IsDir():
			out[rel] = treeEntry{dir: true}
		case d.Type().IsRegular():
			info, err := d.Info()
			if err != nil {
				return err
			}
			out[rel] = treeEntry{size: info.Size(), mod: info.ModTime()}
		default:
			res.Ignored = append(res.Ignored, rel)
		}
		return nil
	})
	return out, err
}

// remoteTree lists a remote folder the same way. A folder that is not there yet is an empty tree.
func remoteTree(rfs RemoteFS, root string, res *TransferResult) (map[string]treeEntry, error) {
	out := map[string]treeEntry{}
	if _, err := rfs.Stat(root); err != nil {
		return out, nil
	}
	var walk func(dir, rel string, depth int) error
	walk = func(dir, rel string, depth int) error {
		if depth > maxTransferDepth {
			return errors.New("folders are nested too deeply")
		}
		entries, err := rfs.List(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if !safeName(e.Name) {
				res.Ignored = append(res.Ignored, path.Join(rel, e.Name)+" (unsafe name)")
				continue
			}
			if len(out) >= maxTransferItems {
				return fmt.Errorf("more than %d items: sync a smaller folder", maxTransferItems)
			}
			r := path.Join(rel, e.Name)
			switch {
			case e.IsLink:
				res.Ignored = append(res.Ignored, r)
			case e.IsDir:
				out[r] = treeEntry{dir: true}
				if err := walk(e.Path, r, depth+1); err != nil {
					return err
				}
			default:
				out[r] = treeEntry{size: e.Size, mod: e.ModTime}
			}
		}
		return nil
	}
	return out, walk(root, "", 0)
}

// diffTrees says what has to be copied from src to dst.
func diffTrees(src, dst map[string]treeEntry) (d SyncDiff, newDirs []string) {
	d = SyncDiff{Copy: []SyncItem{}, Extra: []string{}}
	rels := make([]string, 0, len(src))
	for r := range src {
		rels = append(rels, r)
	}
	sort.Strings(rels) // a folder sorts before what is inside it
	for _, r := range rels {
		s := src[r]
		t, there := dst[r]
		switch {
		case s.dir:
			if !there {
				newDirs = append(newDirs, r)
			}
		case !there || t.dir:
			d.Copy = append(d.Copy, SyncItem{Path: r, Size: s.size, Reason: "new"})
		case s.size != t.size || s.mod.After(t.mod.Add(mtimeSlack)):
			d.Copy = append(d.Copy, SyncItem{Path: r, Size: s.size, Reason: "changed"})
		default:
			d.Same++
		}
	}
	var extra []string
	for r := range dst {
		if _, ok := src[r]; !ok {
			extra = append(extra, r)
		}
	}
	sort.Strings(extra)
	if len(extra) > maxSyncExtra {
		extra = extra[:maxSyncExtra]
	}
	if extra != nil {
		d.Extra = extra
	}
	return d, newDirs
}

// planSync compares srcDir with dstDir (local on the source side for sync-up, remote for sync-down) and
// returns the diff together with the jobs that carry it out.
func planSync(rfs RemoteFS, direction, srcDir, dstDir string, res *TransferResult) (SyncDiff, []job, error) {
	up := direction == "sync-up"
	var local, remote string
	if up {
		local, remote = srcDir, dstDir
	} else {
		local, remote = dstDir, srcDir
	}
	if !filepath.IsAbs(local) || strings.ContainsRune(local, 0) {
		return SyncDiff{}, nil, errors.New("the local folder must be an absolute path")
	}
	if !path.IsAbs(remote) || strings.ContainsRune(remote, 0) || path.Clean(remote) == "/" {
		return SyncDiff{}, nil, errors.New("choose a folder on the server, not its root")
	}
	local, remote = filepath.Clean(local), path.Clean(remote)

	var lt, rt map[string]treeEntry
	var err error
	if lt, err = localTree(local, res); err != nil {
		if up || !isNotExist(err) {
			return SyncDiff{}, nil, err
		}
		lt = map[string]treeEntry{} // a download into a folder that is not there yet
	}
	if rt, err = remoteTree(rfs, remote, res); err != nil {
		return SyncDiff{}, nil, err
	}
	var diff SyncDiff
	var newDirs []string
	var jobs []job
	if up {
		diff, newDirs = diffTrees(lt, rt)
		jobs = append(jobs, job{dir: true, quiet: true, dst: remote, rel: "."})
		for _, r := range newDirs {
			jobs = append(jobs, job{dir: true, dst: path.Join(remote, r), rel: r})
		}
		for _, c := range diff.Copy {
			jobs = append(jobs, job{src: filepath.Join(local, filepath.FromSlash(c.Path)), dst: path.Join(remote, c.Path), rel: c.Path, size: c.Size})
		}
	} else {
		diff, newDirs = diffTrees(rt, lt)
		jobs = append(jobs, job{dir: true, quiet: true, dst: local, rel: "."})
		for _, r := range newDirs {
			jobs = append(jobs, job{dir: true, dst: filepath.Join(local, filepath.FromSlash(r)), rel: r})
		}
		for _, c := range diff.Copy {
			jobs = append(jobs, job{src: path.Join(remote, c.Path), dst: filepath.Join(local, filepath.FromSlash(c.Path)), rel: c.Path, size: c.Size})
		}
	}
	return diff, jobs, nil
}

func isNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }

// SyncPlan compares two folders without changing anything: what a sync from srcDir into dstDir would copy.
// For sync-up srcDir is local and dstDir remote; for sync-down the other way round. Files on the target
// that the source does not have are listed but never deleted.
func (s *SftpService) SyncPlan(sid, direction, srcDir, dstDir string) (SyncDiff, error) {
	x, err := s.get(sid)
	if err != nil {
		return SyncDiff{}, err
	}
	if !isSync(direction) {
		return SyncDiff{}, fmt.Errorf("unknown sync %q", direction)
	}
	res := newResult()
	diff, _, err := planSync(x.fs, direction, srcDir, dstDir, &res)
	return diff, err
}
