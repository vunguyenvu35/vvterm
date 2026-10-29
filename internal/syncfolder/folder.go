// Package syncfolder syncs the encrypted bundle through a folder that a cloud client keeps in
// step (Google Drive for Desktop, iCloud Drive, Dropbox, OneDrive...). Only the two already
// encrypted files are ever written; there is no login and no token.
package syncfolder

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"vvterm/internal/fsutil"
	"vvterm/internal/syncgit"
	"vvterm/internal/vault"
)

// Folder is a synced directory holding bundle.enc and vault-header.json.
type Folder struct {
	Dir string
}

// Check makes sure Dir is an absolute, existing, writable directory.
func (f *Folder) Check() error {
	if !filepath.IsAbs(f.Dir) {
		return errors.New("choose a full folder path")
	}
	st, err := os.Stat(f.Dir)
	if err != nil {
		return fmt.Errorf("folder not available: %w", err)
	}
	if !st.IsDir() {
		return errors.New("that path is not a folder")
	}
	probe, err := os.CreateTemp(f.Dir, ".vvterm-probe-*")
	if err != nil {
		return fmt.Errorf("folder is not writable: %w", err)
	}
	probe.Close()
	return os.Remove(probe.Name())
}

// conflictCopies lists the extra bundles a cloud client leaves when two machines wrote at once
// ("bundle (1).enc", "bundle (conflicted copy).enc", "bundle-MacBook.enc"...).
func (f *Folder) conflictCopies() ([]string, error) {
	ents, err := os.ReadDir(f.Dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		n := e.Name()
		if e.Type().IsRegular() && n != syncgit.BundleFile && strings.HasPrefix(n, "bundle") && strings.HasSuffix(n, ".enc") {
			out = append(out, filepath.Join(f.Dir, n))
		}
	}
	sort.Strings(out)
	return out, nil
}

// Remote returns the header and bundle in the folder; exists=false if none was written yet.
func (f *Folder) Remote() (header vault.Header, bundle []byte, exists bool, err error) {
	hb, err := os.ReadFile(filepath.Join(f.Dir, syncgit.HeaderFile))
	if err != nil {
		return header, nil, false, nil
	}
	if err := json.Unmarshal(hb, &header); err != nil {
		return header, nil, false, fmt.Errorf("%s: %w", syncgit.HeaderFile, err)
	}
	bundle, err = os.ReadFile(filepath.Join(f.Dir, syncgit.BundleFile))
	if err != nil {
		return header, nil, false, nil
	}
	return header, bundle, true, nil
}

func open(s syncgit.Sealer, blob []byte) (syncgit.Bundle, error) {
	var b syncgit.Bundle
	plain, err := s.OpenBlob(blob, []byte(syncgit.BundleAAD))
	if err != nil {
		return b, err
	}
	if err := json.Unmarshal(plain, &b); err != nil {
		return b, fmt.Errorf("bundle corrupt: %w", err)
	}
	return b, nil
}

// Sync merges bundle.enc and every conflict copy into local per record, writes the result back
// and removes the copies that were merged. A copy that cannot be read yet (still downloading) or
// belongs to another vault is left alone.
func (f *Folder) Sync(local syncgit.Bundle, header vault.Header, s syncgit.Sealer) (syncgit.Result, error) {
	res := syncgit.Result{Attempts: 1}
	if err := f.Check(); err != nil {
		return res, err
	}
	remoteHdr, enc, exists, err := f.Remote()
	if err != nil {
		return res, err
	}
	cur := local
	var main syncgit.Bundle
	if exists {
		if main, err = open(s, enc); err != nil {
			return res, syncgit.ErrVaultMismatch
		}
		cur = syncgit.Merge(cur, main)
	}
	copies, err := f.conflictCopies()
	if err != nil {
		return res, err
	}
	var merged []string
	for _, p := range copies {
		blob, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		b, err := open(s, blob)
		if err != nil {
			continue
		}
		cur = syncgit.Merge(cur, b)
		merged = append(merged, p)
	}
	if exists && len(merged) == 0 && same(cur, main, header, remoteHdr) {
		res.Merged = cur
		return res, nil
	}
	plain, err := json.Marshal(cur)
	if err != nil {
		return res, err
	}
	blob, err := s.SealBlob(plain, []byte(syncgit.BundleAAD))
	if err != nil {
		return res, err
	}
	hb, _ := json.MarshalIndent(header, "", "  ")
	if err := fsutil.WriteFileAtomic(filepath.Join(f.Dir, syncgit.BundleFile), blob, 0o600); err != nil {
		return res, err
	}
	if err := fsutil.WriteFileAtomic(filepath.Join(f.Dir, syncgit.HeaderFile), hb, 0o600); err != nil {
		return res, err
	}
	for _, p := range merged {
		_ = os.Remove(p)
	}
	res.Merged, res.Pushed = cur, true
	return res, nil
}

func same(merged, remote syncgit.Bundle, h, remoteH vault.Header) bool {
	a, e1 := json.Marshal(merged)
	b, e2 := json.Marshal(remote)
	ha, e3 := json.Marshal(h)
	hb, e4 := json.Marshal(remoteH)
	return e1 == nil && e2 == nil && e3 == nil && e4 == nil && bytes.Equal(a, b) && bytes.Equal(ha, hb)
}
