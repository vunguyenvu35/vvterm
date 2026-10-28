// Package sftpx adapts github.com/pkg/sftp to the app's RemoteFS port: directory listing, folders,
// rename, delete, and file upload/download with progress. Transfers are written to a temporary file
// and moved into place, so an interrupted transfer never leaves a half-written target.
package sftpx

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

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

const partSuffix = ".vvterm-part"

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

func (f *FS) Mkdir(p string) error {
	p, err := remote(p, false)
	if err != nil {
		return err
	}
	return f.c.Mkdir(p)
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

type progressWriter struct {
	w          io.Writer
	done, size int64
	fn         func(done, total int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	p.done += int64(n)
	if p.fn != nil {
		p.fn(p.done, p.size)
	}
	return n, err
}

// Upload copies a local file to the remote path. Without overwrite an existing remote file is an error.
func (f *FS) Upload(local, rpath string, overwrite bool, progress func(done, total int64)) (err error) {
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

	tmp := rpath + partSuffix
	dst, err := f.c.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = dst.Close()
			_ = f.c.Remove(tmp)
		}
	}()
	if _, err = io.Copy(&progressWriter{w: dst, size: st.Size(), fn: progress}, src); err != nil {
		return err
	}
	if err = dst.Close(); err != nil {
		return err
	}
	if overwrite {
		if err = f.c.PosixRename(tmp, rpath); err != nil { // servers without the extension: replace by hand
			_ = f.c.Remove(rpath)
			err = f.c.Rename(tmp, rpath)
		}
		return err
	}
	return f.c.Rename(tmp, rpath)
}

// Download copies a remote file to the local path. Without overwrite an existing local file is an error.
func (f *FS) Download(rpath, local string, overwrite bool, progress func(done, total int64)) (err error) {
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
	tmp, err := os.CreateTemp(filepath.Dir(local), ".vvterm-*.part")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	if _, err = io.Copy(&progressWriter{w: tmp, size: st.Size(), fn: progress}, src); err != nil {
		return err
	}
	if err = tmp.Chmod(0o644); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), local)
}
