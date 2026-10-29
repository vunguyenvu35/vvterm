// Package secretpolicy keeps secrets out of everything the AI assistant sends or shows. It is pure: no I/O.
//
// Every secret becomes Mask, whatever its length. The agent port only accepts Sanitized values, and
// only Guard can make one, so text cannot reach an agent without going through the guard.
package secretpolicy

import (
	"encoding/base64"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// Mask replaces every secret; its length never depends on the secret.
const Mask = "*******"

// minExactLen is the shortest vault secret that is matched literally: shorter ones would mask ordinary words.
const minExactLen = 4

// Sanitized is text that went through Guard.Redact. The field is not exported, so no other package can
// build one from a raw string.
type Sanitized struct{ text string }

func (s Sanitized) String() string { return s.text }

// IsZero reports whether nothing was sanitized into the value.
func (s Sanitized) IsZero() bool { return s.text == "" }

// Finding says how many secrets of one kind were masked. It never holds the value.
type Finding struct {
	Kind  string `json:"kind"`
	Count int    `json:"count"`
}

// Total is the number of masked secrets.
func Total(fs []Finding) int {
	n := 0
	for _, f := range fs {
		n += f.Count
	}
	return n
}

type rule struct {
	kind string
	re   *regexp.Regexp
	// repl is a regexp replacement template; group 1 (when present) is kept.
	repl string
}

// secretName is a variable or key name that holds a secret. "auth" alone is not enough: it would match "author".
const secretName = `(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|private[_-]?key|credential|auth(?:[_-]?(?:token|key|secret|header)|orization))`

var rules = []rule{
	{"private key", regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`), Mask},
	// a block cut off by the screen: mask to the end
	{"private key", regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*$`), Mask},
	{"aws key", regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`), Mask},
	{"github token", regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})`), Mask},
	{"gitlab token", regexp.MustCompile(`\bglpat-[A-Za-z0-9_\-]{20,}`), Mask},
	{"slack token", regexp.MustCompile(`\bxox[baprs]-[A-Za-z0-9-]{10,}`), Mask},
	{"api key", regexp.MustCompile(`\bsk-[A-Za-z0-9_\-]{20,}`), Mask},
	{"jwt", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), Mask},
	{"auth header", regexp.MustCompile(`(?i)(\bauthorization["']?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token)[ \t]+)[^\s"']+`), "${1}" + Mask},
	{"bearer token", regexp.MustCompile(`(?i)(\bbearer[ \t]+)[A-Za-z0-9._~+/=\-]{16,}`), "${1}" + Mask},
	{"url credentials", regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.\-]*://[^\s/:@]+:)[^\s/@]+(@)`), "${1}" + Mask + "${2}"},
	{"password option", regexp.MustCompile(`(?i)(\B--?(?:password|passwd|pass|token|secret|api[_-]?key)(?:=|[ \t]+))[^\s=-]\S*`), "${1}" + Mask},
	{"secret value", regexp.MustCompile(`(?i)(\b[A-Za-z0-9_.\-]*` + secretName + `[A-Za-z0-9_.\-]*["']?[ \t]*[=:][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)`), "${1}" + Mask},
}

// highEntropy finds a long random-looking value after "=", ":" or a quote.
var highEntropy = regexp.MustCompile(`([=:][ \t]*["']?)([A-Za-z0-9+/=_\-]{20,})`)

var (
	hexOnly   = regexp.MustCompile(`^[0-9a-fA-F]+$`)
	uuidLike  = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	pathLike  = regexp.MustCompile(`^[A-Za-z0-9_.\-]+(/[A-Za-z0-9_.\-]+)+$`)
	maskedRun = regexp.MustCompile(`^\*+$`)
)

// looksRandom is the entropy heuristic: long, mixed letters and digits, high Shannon entropy, and not one of
// the usual random-looking non-secrets (git or image digests, UUIDs, paths).
func looksRandom(s string) bool {
	if len(s) < 20 || uuidLike.MatchString(s) || pathLike.MatchString(s) {
		return false
	}
	if hexOnly.MatchString(s) && (len(s) == 32 || len(s) == 40 || len(s) == 64 || len(s) == 128) {
		return false // md5, sha1, sha256, sha512 digests
	}
	var letters, digits bool
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			digits = true
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			letters = true
		}
	}
	return letters && digits && entropy(s) >= 3.8
}

func entropy(s string) float64 {
	freq := map[rune]float64{}
	n := 0.0
	for _, r := range s {
		freq[r]++
		n++
	}
	h := 0.0
	for _, c := range freq {
		p := c / n
		h -= p * math.Log2(p)
	}
	return h
}

// Guard redacts text. The zero value works and applies the built-in patterns; WithSecrets and WithPatterns
// only add detectors, nothing removes the built-in ones.
type Guard struct {
	exact []string
	extra []*regexp.Regexp
}

// WithSecrets returns a guard that also masks these vault secrets literally, in plain, base64 and URL-encoded
// form. Values shorter than minExactLen are ignored.
func (g Guard) WithSecrets(secrets [][]byte) Guard {
	seen := map[string]bool{}
	out := append([]string(nil), g.exact...)
	for _, s := range out {
		seen[s] = true
	}
	for _, b := range secrets {
		v := strings.TrimSpace(string(b))
		if len(v) < minExactLen {
			continue
		}
		forms := []string{v, base64.StdEncoding.EncodeToString([]byte(v)), base64.RawStdEncoding.EncodeToString([]byte(v)), url.QueryEscape(v)}
		if strings.Contains(v, "\n") { // multi-line secrets (keys) also show up one line at a time
			for _, ln := range strings.Split(v, "\n") {
				if ln = strings.TrimSpace(ln); len(ln) >= 16 {
					forms = append(forms, ln)
				}
			}
		}
		for _, f := range forms {
			if len(f) >= minExactLen && !seen[f] {
				seen[f] = true
				out = append(out, f)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) }) // longest first
	g.exact = out
	return g
}

// WithPatterns adds the user's own regular expressions. A pattern that does not compile is an error.
func (g Guard) WithPatterns(patterns []string) (Guard, error) {
	extra := append([]*regexp.Regexp(nil), g.extra...)
	for _, p := range patterns {
		if strings.TrimSpace(p) == "" {
			continue
		}
		re, err := regexp.Compile(p)
		if err != nil {
			return g, fmt.Errorf("pattern %q: %w", p, err)
		}
		extra = append(extra, re)
	}
	g.extra = extra
	return g, nil
}

// Redact masks every secret it can find. It fails closed: if redaction itself breaks, the caller gets an
// error and no Sanitized value, so nothing is sent.
func (g Guard) Redact(text string) (out Sanitized, findings []Finding, err error) {
	defer func() {
		if r := recover(); r != nil {
			out, findings, err = Sanitized{}, nil, fmt.Errorf("redaction failed: %v", r)
		}
	}()
	s, f := g.apply(text)
	return Sanitized{text: s}, f, nil
}

// Clean masks text that is only displayed or stored (an agent reply, a log line).
func (g Guard) Clean(text string) (string, []Finding) { return g.apply(text) }

// Contains reports whether text holds a secret or already the mask; a command that does must not be run
// from the UI, because the agent cannot know the real value and the user should type it.
func (g Guard) Contains(text string) bool {
	if strings.Contains(text, Mask) {
		return true
	}
	_, f := g.apply(text)
	return len(f) > 0
}

func (g Guard) apply(text string) (string, []Finding) {
	counts := map[string]int{}
	add := func(kind string, n int) {
		if n > 0 {
			counts[kind] += n
		}
	}
	for _, r := range rules[:2] { // key blocks first so their lines are not matched again
		text = replaceCount(text, r, add)
	}
	for _, e := range g.exact {
		if n := strings.Count(text, e); n > 0 {
			add("vault secret", n)
			text = strings.ReplaceAll(text, e, Mask)
		}
	}
	for _, r := range rules[2:] {
		text = replaceCount(text, r, add)
	}
	text = highEntropy.ReplaceAllStringFunc(text, func(m string) string {
		sm := highEntropy.FindStringSubmatch(m)
		if maskedRun.MatchString(sm[2]) || !looksRandom(sm[2]) {
			return m
		}
		add("high entropy value", 1)
		return sm[1] + Mask
	})
	for _, re := range g.extra {
		if n := len(re.FindAllStringIndex(text, -1)); n > 0 {
			add("custom pattern", n)
			text = re.ReplaceAllString(text, Mask)
		}
	}
	var fs []Finding
	for k, n := range counts {
		fs = append(fs, Finding{Kind: k, Count: n})
	}
	sort.Slice(fs, func(i, j int) bool { return fs[i].Kind < fs[j].Kind })
	return text, fs
}

// replaceCount applies a rule and counts only real changes: a value that is already the mask stays a no-op.
func replaceCount(text string, r rule, add func(string, int)) string {
	return r.re.ReplaceAllStringFunc(text, func(m string) string {
		out := r.re.ReplaceAllString(m, r.repl)
		if out == m {
			return m
		}
		add(r.kind, 1)
		return out
	})
}
