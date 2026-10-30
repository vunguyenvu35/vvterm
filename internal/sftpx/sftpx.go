// Package sftpx adapts github.com/pkg/sftp to the app's RemoteFS port: directory listing, folders,
// rename, delete, and file upload/download with progress. Transfers are written to a temporary file
// and moved into place, so an interrupted transfer never leaves a half-written target. The temporary
// file is named after the size and time of the source, so a transfer that was interrupted (a lost
// connection, Pause) continues from the bytes already written when it is started again, and only when
// the source has not changed in between.
package sftpx

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"vvterm/internal/domain"
)

var (
	// ErrExists is returned when the target exists and overwrite was not requested.
	ErrExists = errors.New("already exists")
	// ErrBadPath is returned for paths that are empty, relative, contain NUL, or point at the root.
	ErrBadPath = errors.New("invalid path")
)

const (
	partSuffix = ".vvterm-part"
	// rewind is how much of an interrupted file is written again when a transfer continues: the last
	// chunk may have been cut short.
	rewind = 64 << 10
)

// fingerprint names the version of a source file, so a partial copy of another version is never continued.
func fingerprint(size int64, mod time.Time) string {
	h := fnv.New32a()
	fmt.Fprintf(h, "%d/%d", size, mod.UnixNano())
	return fmt.Sprintf("%08x", h.Sum32())
}

func resumeOffset(have, size int64) int64 {
	if have > size || have < rewind {
		return 0
	}
	return have - rewind
}

// FS is an SFTP session over an SSH connection.
type FS struct{ c *sftp.Client }

// Open starts the sftp subsystem on an established SSH connection.
func Open(cl *ssh.Client) (*FS, error) {
	c, err := sftp.NewClient(cl)
	if err != nil {
		return nil, fmt.Errorf("start sftp: %w", err)
	}
	return &FS{c: c}, nil
}

func (f *FS) Close() error { return f.c.Close() }

// Home returns the remote working directory (usually the user's home).
func (f *FS) Home() (string, error) { return f.c.Getwd() }

// remote validates and cleans an absolute remote path. The root is only acceptable when allowRoot is set.
func remote(p string, allowRoot bool) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) || !strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("%w: %q must be an absolute path", ErrBadPath, p)
	}
	c := path.Clean(p)
	if c == "/" && !allowRoot {
		return "", fmt.Errorf("%w: refusing to operate on the root directory", ErrBadPath)
	}
	return c, nil
}

// List returns the entries of dir: directories first, then files, each sorted by name.
func (f *FS) List(dir string) ([]domain.RemoteEntry, error) {
	dir, err := remote(dir, true)
	if err != nil {
		return nil, err
	}
	infos, err := f.c.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]domain.RemoteEntry, 0, len(infos))
	for _, fi := range infos {
		full := path.Join(dir, fi.Name())
		e := domain.RemoteEntry{Name: fi.Name(), Path: full, Size: fi.Size(), Mode: fi.Mode().String(), ModTime: fi.ModTime(),
			IsDir: fi.IsDir(), IsLink: fi.Mode()&os.ModeSymlink != 0}
		if e.IsLink { // a link to a directory should open like a directory
			if st, err := f.c.Stat(full); err == nil {
				e.IsDir = st.IsDir()
				e.Size = st.Size()
			}
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// Stat describes one remote file or directory.
func (f *FS) Stat(p string) (domain.RemoteEntry, error) {
	p, err := remote(p, true)
	if err != nil {
		return domain.RemoteEntry{}, err
	}
	fi, err := f.c.Stat(p)
	if err != nil {
		return domain.RemoteEntry{}, err
	}
	return domain.RemoteEntry{Name: fi.Name(), Path: p, Size: fi.Size(), Mode: fi.Mode().String(), ModTime: fi.ModTime(), IsDir: fi.IsDir()}, nil
}

func (f *FS) Mkdir(p string) error {
	p, err := remote(p, false)
	if err != nil {
		return err
	}
	return f.c.Mkdir(p)
}

// Chmod sets the permission bits (rwx for owner, group, others, and setuid/setgid/sticky).
func (f *FS) Chmod(p string, mode uint32) error {
	p, err := remote(p, false)
	if err != nil {
		return err
	}
	return f.c.Chmod(p, os.FileMode(mode&0o7777))
}

func (f *FS) Rename(from, to string) error {
	from, err := remote(from, false)
	if err != nil {
		return err
	}
	to, err = remote(to, false)
	if err != nil {
		return err
	}
	if _, err := f.c.Lstat(to); err == nil {
		return fmt.Errorf("%s: %w", to, ErrExists)
	}
	return f.c.Rename(from, to)
}

// Remove deletes a file or an empty directory; with recursive it deletes a directory tree.
func (f *FS) Remove(p string, recursive bool) error {
	p, err := remote(p, false)
	if err != nil {
		return err
	}
	if recursive {
		return f.c.RemoveAll(p)
	}
	return f.c.Remove(p)
}

// copyCtx copies src to dst, stopping with the context's cause as soon as it is cancelled. progress is
// told the bytes written so far (counting from base, the bytes a continued transfer already had).
func copyCtx(ctx context.Context, dst io.Writer, src io.Reader, base, size int64, progress func(done, total int64)) error {
	buf := make([]byte, 128<<10)
	done := base
	for {
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			w, werr := dst.Write(buf[:n])
			done += int64(w)
			if progress != nil {
				progress(done, size)
			}
			if werr != nil {
				return werr
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// discard is true when the transfer was cancelled for good (not paused, not interrupted): its partial
// file is then deleted instead of kept for a later continue.
func discard(ctx context.Context) bool {
	return errors.Is(context.Cause(ctx), domain.ErrTransferDiscarded)
}

// Upload copies a local file to the remote path. Without overwrite an existing remote file is an error.
// An interrupted upload leaves its partial file next to the target and continues from it next time.
func (f *FS) Upload(ctx context.Context, local, rpath string, overwrite bool, progress func(done, total int64)) (err error) {
	rpath, err = remote(rpath, false)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(local) {
		return fmt.Errorf("%w: local path must be absolute", ErrBadPath)
	}
	st, err := os.Stat(local)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return errors.New("uploading a directory is not supported yet: choose a file")
	}
	if !overwrite {
		if _, err := f.c.Lstat(rpath); err == nil {
			return fmt.Errorf("%s: %w", rpath, ErrExists)
		}
	}
	src, err := os.Open(local)
	if err != nil {
		return err
	}
	defer src.Close()

	tmp := rpath + partSuffix + "-" + fingerprint(st.Size(), st.ModTime())
	var offset int64
	if have, serr := f.c.Stat(tmp); serr == nil && have.Mode().IsRegular() {
		offset = resumeOffset(have.Size(), st.Size())
	}
	flags := os.O_WRONLY | os.O_CREATE
	if offset == 0 {
		flags |= os.O_TRUNC
	}
	dst, err := f.c.OpenFile(tmp, flags)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			_ = dst.Close()
		}
		if err != nil && discard(ctx) {
			_ = f.c.Remove(tmp)
		}
	}()
	if offset > 0 {
		if _, err = src.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		if _, err = dst.Seek(offset, io.SeekStart); err != nil {
			return err
		}
	}
	if err = copyCtx(ctx, dst, src, offset, st.Size(), progress); err != nil {
		return err
	}
	closed = true
	if err = dst.Close(); err != nil {
		return err
	}
	if overwrite {
		old, serr := f.c.Stat(rpath)                       // the replacement keeps the permissions of the file it replaces
		if err = f.c.PosixRename(tmp, rpath); err != nil { // servers without the extension: replace by hand
			_ = f.c.Remove(rpath)
			err = f.c.Rename(tmp, rpath)
		}
		if err == nil && serr == nil {
			_ = f.c.Chmod(rpath, old.Mode().Perm())
		}
		return err
	}
	return f.c.Rename(tmp, rpath)
}

// Download copies a remote file to the local path. Without overwrite an existing local file is an error.
// An interrupted download leaves a hidden partial file next to the target and continues from it next time.
func (f *FS) Download(ctx context.Context, rpath, local string, overwrite bool, progress func(done, total int64)) (err error) {
	rpath, err = remote(rpath, false)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(local) {
		return fmt.Errorf("%w: local path must be absolute", ErrBadPath)
	}
	if !overwrite {
		if _, err := os.Lstat(local); err == nil {
			return fmt.Errorf("%s: %w", local, ErrExists)
		}
	}
	st, err := f.c.Stat(rpath)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return errors.New("downloading a directory is not supported yet: choose a file")
	}
	src, err := f.c.Open(rpath)
	if err != nil {
		return err
	}
	defer src.Close()
	partPath := filepath.Join(filepath.Dir(local), "."+filepath.Base(local)+partSuffix+"-"+fingerprint(st.Size(), st.ModTime()))
	var offset int64
	if have, serr := os.Stat(partPath); serr == nil && have.Mode().IsRegular() {
		offset = resumeOffset(have.Size(), st.Size())
	}
	tmp, err := os.OpenFile(partPath, os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
		if err != nil && discard(ctx) {
			_ = os.Remove(partPath)
		}
	}()
	if err = tmp.Truncate(offset); err != nil {
		return err
	}
	if _, err = tmp.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	if offset > 0 {
		if _, err = src.Seek(offset, io.SeekStart); err != nil {
			return err
		}
	}
	if err = copyCtx(ctx, tmp, src, offset, st.Size(), progress); err != nil {
		return err
	}
	if err = tmp.Chmod(0o644); err != nil {
		return err
	}
	closed = true
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(partPath, local)
}
