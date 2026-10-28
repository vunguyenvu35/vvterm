// Package importer parses OpenSSH client config files into VVTerm records.
package importer

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Entry is one concrete (non-wildcard) Host block.
type Entry struct {
	Alias        string
	HostName     string
	Port         int
	User         string
	IdentityFile string
	ProxyJump    []string // alias or [user@]host[:port], outermost first
	Local        []Fwd
	Remote       []Fwd
	Dynamic      []Fwd
	Env          string
	Tags         []string
	Source       string // file the block came from
}

// Fwd is a parsed *Forward directive.
type Fwd struct {
	BindAddr string
	BindPort int
	DestHost string
	DestPort int
}

// Parsed is the result of reading a config tree.
type Parsed struct {
	Entries  []Entry
	Warnings []string

	ptrs []*Entry
}

const maxIncludeDepth = 8

// ParseFile reads path and follows Include directives (relative paths resolve
// against the directory of the including file, or ~/.ssh as OpenSSH does for
// the user config).
func ParseFile(path string) (*Parsed, error) {
	p := &Parsed{}
	if err := p.parse(path, 0, map[string]bool{}); err != nil {
		return nil, err
	}
	for _, e := range p.ptrs {
		p.Entries = append(p.Entries, *e)
	}
	p.ptrs = nil
	return p, nil
}

func (p *Parsed) warn(f string, a ...any) { p.Warnings = append(p.Warnings, fmt.Sprintf(f, a...)) }

func (p *Parsed) parse(path string, depth int, seen map[string]bool) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if seen[abs] {
		p.warn("%s: include loop skipped", path)
		return nil
	}
	seen[abs] = true
	defer delete(seen, abs)

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	source := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	var cur []*Entry // entries of the current Host line (one per pattern)
	var pendingEnv string
	var pendingTags []string

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		raw := strings.TrimSpace(sc.Text())
		if raw == "" {
			continue
		}
		if strings.HasPrefix(raw, "#") {
			if m, ok := strings.CutPrefix(raw, "# vvterm:"); ok {
				pendingEnv, pendingTags = parseMeta(m)
			}
			continue
		}
		key, val := splitKV(raw)
		switch strings.ToLower(key) {
		case "include":
			if depth+1 > maxIncludeDepth {
				p.warn("%s:%d: include too deep", path, lineNo)
				continue
			}
			for _, pat := range strings.Fields(val) {
				for _, file := range expandInclude(pat, filepath.Dir(path)) {
					if err := p.parse(file, depth+1, seen); err != nil {
						p.warn("%s:%d: include %s: %v", path, lineNo, file, err)
					}
				}
			}
			cur = nil
		case "host":
			cur = nil
			for _, pat := range strings.Fields(val) {
				if strings.ContainsAny(pat, "*?!") {
					continue // wildcard defaults are not concrete hosts
				}
				e := &Entry{Alias: pat, Source: source, Env: pendingEnv, Tags: pendingTags}
				cur = append(cur, e)
			}
			pendingEnv, pendingTags = "", nil
			if len(cur) == 0 {
				p.warn("%s:%d: wildcard Host block skipped", path, lineNo)
			}
			p.ptrs = append(p.ptrs, cur...)
		default:
			for _, e := range cur {
				p.apply(e, strings.ToLower(key), val, path, lineNo)
			}
		}
	}
	return sc.Err()
}

func (p *Parsed) apply(e *Entry, key, val, path string, line int) {
	switch key {
	case "hostname":
		e.HostName = val
	case "port":
		if n, err := strconv.Atoi(val); err == nil && n > 0 && n < 65536 {
			e.Port = n
		} else {
			p.warn("%s:%d: invalid Port %q", path, line, val)
		}
	case "user":
		e.User = val
	case "identityfile":
		if e.IdentityFile == "" {
			e.IdentityFile = expandHome(strings.Trim(val, `"`))
		}
	case "proxyjump":
		if strings.EqualFold(val, "none") {
			return
		}
		for _, j := range strings.Split(val, ",") {
			if j = strings.TrimSpace(j); j != "" {
				e.ProxyJump = append(e.ProxyJump, j)
			}
		}
	case "proxycommand":
		p.warn("%s:%d: ProxyCommand on %q is not supported and was ignored", path, line, e.Alias)
	case "localforward", "remoteforward":
		f, err := parseForward(val, true)
		if err != nil {
			p.warn("%s:%d: %v", path, line, err)
			return
		}
		if key == "localforward" {
			e.Local = append(e.Local, f)
		} else {
			e.Remote = append(e.Remote, f)
		}
	case "dynamicforward":
		f, err := parseForward(val, false)
		if err != nil {
			p.warn("%s:%d: %v", path, line, err)
			return
		}
		e.Dynamic = append(e.Dynamic, f)
	}
}

func splitKV(s string) (string, string) {
	i := strings.IndexAny(s, " \t=")
	if i < 0 {
		return s, ""
	}
	return s[:i], strings.TrimSpace(strings.TrimLeft(s[i:], " \t="))
}

func parseMeta(s string) (env string, tags []string) {
	for _, f := range strings.Fields(s) {
		k, v, ok := strings.Cut(f, "=")
		if !ok {
			continue
		}
		switch k {
		case "env":
			env = v
		case "tags":
			for _, t := range strings.Split(v, ",") {
				if t != "" {
					tags = append(tags, t)
				}
			}
		}
	}
	return
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

func expandInclude(pat, base string) []string {
	pat = expandHome(pat)
	if !filepath.IsAbs(pat) {
		pat = filepath.Join(base, pat)
	}
	m, _ := filepath.Glob(pat)
	return m
}

// parseForward handles "[bind_address:]port host:hostport" (or just "[bind:]port" for -D).
func parseForward(val string, withDest bool) (Fwd, error) {
	fs := strings.Fields(val)
	want := 1
	if withDest {
		want = 2
	}
	if len(fs) != want {
		return Fwd{}, fmt.Errorf("malformed forward %q", val)
	}
	var f Fwd
	bind := fs[0]
	if i := strings.LastIndex(bind, ":"); i >= 0 {
		f.BindAddr = strings.Trim(bind[:i], "[]")
		bind = bind[i+1:]
	}
	n, err := strconv.Atoi(bind)
	if err != nil || n < 0 || n > 65535 {
		return Fwd{}, fmt.Errorf("invalid bind port in %q", val)
	}
	f.BindPort = n
	if withDest {
		h, ps, err := splitHostPort(fs[1])
		if err != nil {
			return Fwd{}, fmt.Errorf("invalid destination in %q", val)
		}
		f.DestHost, f.DestPort = h, ps
	}
	return f, nil
}

func splitHostPort(s string) (string, int, error) {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return "", 0, fmt.Errorf("missing port")
	}
	n, err := strconv.Atoi(s[i+1:])
	if err != nil || n < 1 || n > 65535 {
		return "", 0, fmt.Errorf("bad port")
	}
	return strings.Trim(s[:i], "[]"), n, nil
}

// ParseJumpSpec splits "[user@]host[:port]".
func ParseJumpSpec(s string) (user, host string, port int) {
	port = 22
	if i := strings.Index(s, "@"); i >= 0 {
		user, s = s[:i], s[i+1:]
	}
	if i := strings.LastIndex(s, ":"); i >= 0 && !strings.Contains(s[i:], "]") {
		if n, err := strconv.Atoi(s[i+1:]); err == nil {
			port = n
			s = s[:i]
		}
	}
	return user, strings.Trim(s, "[]"), port
}
