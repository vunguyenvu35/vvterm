package usecase

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"vvterm/internal/domain"
)

// LocalService browses and edits this computer's files for the SFTP screen (the "Local" pane). Paths
// must be absolute; the vault, the database and the app's own files get no special treatment because
// the user owns them, but roots and the home folder can never be deleted or renamed away.
type LocalService struct{}

func NewLocalService() *LocalService { return &LocalService{} }

var errLocalPath = errors.New("enter an absolute path")

func localPath(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) || !filepath.IsAbs(p) {
		return "", errLocalPath
	}
	return filepath.Clean(p), nil
}

// Home returns the user's home folder (the pane's starting point).
func (s *LocalService) Home() (string, error) { return os.UserHomeDir() }

// List returns the entries of a folder, folders first, then by name. Hidden files are included: the
// UI decides whether to show them.
func (s *LocalService) List(dir string) ([]domain.RemoteEntry, error) {
	d, err := localPath(dir)
	if err != nil {
		return nil, err
	}
	items, err := os.ReadDir(d)
	if err != nil {
		return nil, err
	}
	out := make([]domain.RemoteEntry, 0, len(items))
	for _, it := range items {
		info, err := it.Info()
		if err != nil {
			continue // vanished while listing
		}
		e := domain.RemoteEntry{Name: it.Name(), Path: filepath.Join(d, it.Name()), Size: info.Size(), Mode: info.Mode().String(), ModTime: info.ModTime(), IsDir: info.IsDir()}
		if info.Mode()&os.ModeSymlink != 0 {
			e.IsLink = true
			if t, err := os.Stat(e.Path); err == nil {
				e.IsDir = t.IsDir()
				e.Size = t.Size()
			}
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// Mkdir creates one folder; it never overwrites.
func (s *LocalService) Mkdir(path string) error {
	p, err := localPath(path)
	if err != nil {
		return err
	}
	return os.Mkdir(p, 0o755)
}

// Rename moves a file or folder inside the same filesystem and refuses to replace an existing one.
func (s *LocalService) Rename(from, to string) error {
	a, err := localPath(from)
	if err != nil {
		return err
	}
	b, err := localPath(to)
	if err != nil {
		return err
	}
	if err := s.protected(a); err != nil {
		return err
	}
	if _, err := os.Lstat(b); err == nil {
		return fmt.Errorf("%s already exists", b)
	}
	return os.Rename(a, b)
}

// Delete removes a file, or a folder with everything in it when recursive is true.
func (s *LocalService) Delete(path string, recursive bool) error {
	p, err := localPath(path)
	if err != nil {
		return err
	}
	if err := s.protected(p); err != nil {
		return err
	}
	if recursive {
		return os.RemoveAll(p)
	}
	return os.Remove(p)
}

// protected refuses the filesystem root and the home folder.
func (s *LocalService) protected(p string) error {
	if p == filepath.Dir(p) {
		return errors.New("refusing to change the root folder")
	}
	if h, err := os.UserHomeDir(); err == nil && filepath.Clean(h) == p {
		return errors.New("refusing to change the home folder")
	}
	return nil
}
