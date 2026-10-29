// Package agentx runs the AI command-line tools (Claude Code, Codex, Gemini, custom) as isolated
// subprocesses. It implements the usecase.Agent port. Isolation is the point of the package: an agent gets an
// empty working directory, a scrubbed environment and no tools, so the only data it can see is the prompt.
package agentx

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ErrNeedsSignIn is returned when the CLI says the user is not signed in.
var ErrNeedsSignIn = errors.New("the provider is not signed in")

const (
	maxStdout = 8 << 20
	maxStderr = 64 << 10
)

var (
	loginPathOnce sync.Once
	loginPath     string
)

// searchPath is the PATH of the user's login shell plus the usual install folders. A GUI app on macOS does
// not inherit the shell's PATH, so the CLIs would not be found otherwise.
func searchPath() string {
	loginPathOnce.Do(func() {
		var dirs []string
		if runtime.GOOS != "windows" {
			sh := os.Getenv("SHELL")
			if sh == "" {
				sh = "/bin/sh"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if out, err := exec.CommandContext(ctx, sh, "-lc", `printf %s "$PATH"`).Output(); err == nil {
				dirs = append(dirs, filepath.SplitList(string(out))...)
			}
		}
		dirs = append(dirs, filepath.SplitList(os.Getenv("PATH"))...)
		if home, err := os.UserHomeDir(); err == nil {
			dirs = append(dirs, filepath.Join(home, ".local", "bin"), filepath.Join(home, ".claude", "local"), filepath.Join(home, ".npm-global", "bin"))
		}
		dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")
		seen := map[string]bool{}
		var uniq []string
		for _, d := range dirs {
			if d != "" && !seen[d] {
				seen[d] = true
				uniq = append(uniq, d)
			}
		}
		loginPath = strings.Join(uniq, string(os.PathListSeparator))
	})
	return loginPath
}

// findBinary looks for name in searchPath. It returns "" when absent.
func findBinary(name string) string {
	for _, d := range filepath.SplitList(searchPath()) {
		p := filepath.Join(d, name)
		if runtime.GOOS == "windows" {
			for _, ext := range []string{".exe", ".cmd", ".bat"} {
				if st, err := os.Stat(p + ext); err == nil && !st.IsDir() {
					return p + ext
				}
			}
			continue
		}
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}

var secretEnvName = regexp.MustCompile(`(?i)pass|secret|token|key|credential|auth|session|cookie`)

// baseEnv is the only environment an agent process gets: what a CLI needs to find its own login and
// nothing else. No SSH_AUTH_SOCK, no VVTERM_*, nothing whose name looks like a secret. extra names are
// per-adapter settings folders (CLAUDE_CONFIG_DIR, CODEX_HOME, ...).
func baseEnv(extra ...string) []string {
	keep := map[string]bool{"HOME": true, "USER": true, "LOGNAME": true, "LANG": true, "TMPDIR": true, "SHELL": true,
		"TERM": true, "USERPROFILE": true, "APPDATA": true, "LOCALAPPDATA": true, "SYSTEMROOT": true, "TEMP": true, "TMP": true,
		"XDG_CONFIG_HOME": true, "XDG_DATA_HOME": true, "XDG_STATE_HOME": true, "XDG_CACHE_HOME": true}
	for _, e := range extra {
		keep[e] = true
	}
	env := []string{"PATH=" + searchPath()}
	for _, kv := range os.Environ() {
		name, _, ok := strings.Cut(kv, "=")
		if !ok || name == "PATH" {
			continue
		}
		if (keep[name] || strings.HasPrefix(name, "LC_")) && !secretEnvName.MatchString(name) {
			env = append(env, kv)
		}
	}
	return env
}

// tempDir is the working directory of one agent call: new, empty, removed afterwards.
func tempDir() (string, func(), error) {
	d, err := os.MkdirTemp("", "vvterm-agent-*")
	if err != nil {
		return "", nil, err
	}
	return d, func() { os.RemoveAll(d) }, nil
}

type runOpts struct {
	bin   string
	args  []string
	stdin string
	dir   string
	env   []string
	// onLine gets each stdout line; returning an error stops the process and is the result of run.
	onLine func(line []byte) error
}

// run starts the process, feeds stdin, reads stdout by lines and returns stderr. The process dies with ctx.
func run(ctx context.Context, o runOpts) (string, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, o.bin, o.args...)
	cmd.Dir, cmd.Env = o.dir, o.env
	cmd.WaitDelay = 2 * time.Second
	setProcAttr(cmd)
	if o.stdin != "" {
		cmd.Stdin = strings.NewReader(o.stdin)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	var stderr limitedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return "", err
	}
	var cbErr error
	r := bufio.NewReaderSize(out, 64<<10)
	total := 0
	for {
		line, rerr := r.ReadBytes('\n')
		total += len(line)
		if len(bytes.TrimSpace(line)) > 0 && o.onLine != nil && cbErr == nil {
			if cbErr = o.onLine(bytes.TrimRight(line, "\r\n")); cbErr != nil {
				cancel()
			}
		}
		if total > maxStdout && cbErr == nil {
			cbErr = errors.New("the agent produced too much output")
			cancel()
		}
		if rerr != nil {
			if rerr != io.EOF && cbErr == nil && ctx.Err() == nil {
				cbErr = rerr
			}
			break
		}
	}
	waitErr := cmd.Wait()
	if cbErr != nil {
		return stderr.String(), cbErr
	}
	if ctx.Err() != nil {
		return stderr.String(), ctx.Err()
	}
	return stderr.String(), waitErr
}

type limitedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if room := maxStderr - l.b.Len(); room > 0 {
		if len(p) > room {
			l.b.Write(p[:room])
		} else {
			l.b.Write(p)
		}
	}
	return len(p), nil
}

func (l *limitedBuffer) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

// output runs a short command and returns its combined output; used by detection.
func output(bin string, timeout time.Duration, env []string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env
	cmd.WaitDelay = time.Second
	b, err := cmd.CombinedOutput()
	return string(b), err
}

var versionRe = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

func parseVersion(s string) string { return versionRe.FindString(s) }

func needsSignIn(text string) bool {
	t := strings.ToLower(text)
	for _, k := range []string{"not logged in", "please run /login", "run `claude login`", "invalid api key", "please log in", "not signed in",
		"authentication", "unauthorized", "sign in", "login required", "invalid auth method", "401"} {
		if strings.Contains(t, k) {
			return true
		}
	}
	return false
}

// BaseEnv is the scrubbed environment (see baseEnv), for other packages that start tools on the user's behalf.
func BaseEnv(extra ...string) []string { return baseEnv(extra...) }

// FindBinary looks a program up on the login shell's PATH and the usual install folders.
func FindBinary(name string) string { return findBinary(name) }
