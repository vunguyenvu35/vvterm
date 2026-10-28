package syncgit

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"vvterm/internal/fsutil"

	"vvterm/internal/vault"
)

const (
	BundleFile = "bundle.enc"
	HeaderFile = "vault-header.json"
	BundleAAD  = "vvterm/bundle/v1"
	maxRetries = 5
)

var (
	ErrVaultMismatch = errors.New("remote bundle was encrypted with a different vault key")
	ErrPushRace      = errors.New("remote kept changing; giving up after several attempts")
)

// Sealer is the vault subset used to encrypt/decrypt the bundle.
type Sealer interface {
	SealBlob(plain, aad []byte) ([]byte, error)
	OpenBlob(blob, aad []byte) ([]byte, error)
}

// Repo is a local working copy of the sync repository, driven by the git CLI.
type Repo struct {
	Dir    string
	URL    string
	Branch string
	Git    string // git executable, default "git"
}

func (r *Repo) branch() string {
	if r.Branch == "" {
		return "main"
	}
	return r.Branch
}

func (r *Repo) run(args ...string) (string, error) {
	g := r.Git
	if g == "" {
		g = "git"
	}
	full := append([]string{"-c", "user.name=VVTerm", "-c", "user.email=vvterm@localhost",
		"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"}, args...)
	cmd := exec.Command(g, full...)
	cmd.Dir = r.Dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=true", "LC_ALL=C")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

// Init prepares the working copy and points origin at URL.
func (r *Repo) Init() error {
	if r.URL == "" {
		return errors.New("repository URL is required")
	}
	if strings.HasPrefix(r.URL, "-") {
		return errors.New("invalid repository URL")
	}
	if err := os.MkdirAll(r.Dir, 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(r.Dir, ".git")); err != nil {
		if _, err := r.run("init", "-q", "-b", r.branch()); err != nil {
			return err
		}
	}
	if _, err := r.run("remote", "get-url", "origin"); err != nil {
		_, err = r.run("remote", "add", "origin", r.URL)
		return err
	}
	_, err := r.run("remote", "set-url", "origin", r.URL)
	return err
}

func (r *Repo) remoteRef() string { return "origin/" + r.branch() }

// Fetch updates origin; an empty remote is not an error.
func (r *Repo) Fetch() error {
	_, err := r.run("fetch", "-q", "origin")
	return err
}

// Remote returns the header and bundle at origin/<branch>, exists=false if none are published yet.
func (r *Repo) Remote() (header vault.Header, bundle []byte, exists bool, err error) {
	if _, e := r.run("rev-parse", "--verify", "-q", r.remoteRef()); e != nil {
		return header, nil, false, nil
	}
	hb, err := r.run("show", r.remoteRef()+":"+HeaderFile)
	if err != nil {
		return header, nil, false, nil
	}
	if err := json.Unmarshal([]byte(hb), &header); err != nil {
		return header, nil, false, fmt.Errorf("remote %s: %w", HeaderFile, err)
	}
	bb, err := r.run("show", r.remoteRef()+":"+BundleFile)
	if err != nil {
		return header, nil, false, nil
	}
	return header, []byte(bb), true, nil
}

func (r *Repo) commitPush(header vault.Header, bundle []byte, msg string) (pushed bool, err error) {
	if _, e := r.run("rev-parse", "--verify", "-q", r.remoteRef()); e == nil {
		if _, err := r.run("checkout", "-q", "-B", r.branch(), r.remoteRef()); err != nil {
			return false, err
		}
		if _, err := r.run("reset", "-q", "--hard", r.remoteRef()); err != nil {
			return false, err
		}
	}
	hb, _ := json.MarshalIndent(header, "", "  ")
	if err := fsutil.WriteFileAtomic(filepath.Join(r.Dir, HeaderFile), hb, 0o600); err != nil {
		return false, err
	}
	if err := fsutil.WriteFileAtomic(filepath.Join(r.Dir, BundleFile), bundle, 0o600); err != nil {
		return false, err
	}
	if _, err := r.run("add", HeaderFile, BundleFile); err != nil {
		return false, err
	}
	if st, _ := r.run("status", "--porcelain"); strings.TrimSpace(st) == "" {
		return false, nil // nothing changed
	}
	if _, err := r.run("commit", "-q", "-m", msg); err != nil {
		return false, err
	}
	if _, err := r.run("push", "-q", "origin", "HEAD:refs/heads/"+r.branch()); err != nil {
		return false, err
	}
	return true, nil
}

// Result describes one sync run.
type Result struct {
	Merged   Bundle
	Pushed   bool
	Attempts int
}

// Sync fetches, merges the remote bundle into local, and pushes on top of origin.
// If the push is rejected because another machine pushed first, it starts over.
func (r *Repo) Sync(local Bundle, header vault.Header, s Sealer) (Result, error) {
	var res Result
	cur := local
	for attempt := 1; attempt <= maxRetries; attempt++ {
		res.Attempts = attempt
		if err := r.Fetch(); err != nil {
			return res, err
		}
		remoteHdr, enc, exists, err := r.Remote()
		if err != nil {
			return res, err
		}
		if exists {
			plain, err := s.OpenBlob(enc, []byte(BundleAAD))
			if err != nil {
				return res, ErrVaultMismatch
			}
			var remote Bundle
			if err := json.Unmarshal(plain, &remote); err != nil {
				return res, fmt.Errorf("remote bundle corrupt: %w", err)
			}
			cur = Merge(local, remote)
			// Random GCM nonces make every seal differ, so compare content to avoid empty commits.
			if unchanged(cur, remote, header, remoteHdr) {
				res.Merged = cur
				return res, nil
			}
		}
		plain, err := json.Marshal(cur)
		if err != nil {
			return res, err
		}
		blob, err := s.SealBlob(plain, []byte(BundleAAD))
		if err != nil {
			return res, err
		}
		pushed, err := r.commitPush(header, blob, "VVTerm sync")
		if err == nil {
			res.Merged, res.Pushed = cur, pushed
			return res, nil
		}
		if !isRejected(err) {
			return res, err
		}
	}
	return res, ErrPushRace
}

func unchanged(merged, remote Bundle, h, remoteH vault.Header) bool {
	a, err1 := json.Marshal(merged)
	b, err2 := json.Marshal(remote)
	ha, err3 := json.Marshal(h)
	hb, err4 := json.Marshal(remoteH)
	return err1 == nil && err2 == nil && err3 == nil && err4 == nil && bytes.Equal(a, b) && bytes.Equal(ha, hb)
}

func isRejected(err error) bool {
	m := err.Error()
	return strings.Contains(m, "rejected") || strings.Contains(m, "non-fast-forward") ||
		strings.Contains(m, "fetch first") || strings.Contains(m, "failed to push")
}
