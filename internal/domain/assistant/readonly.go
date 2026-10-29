package assistant

import (
	"regexp"
	"strings"
)

// A command that only reads can be run by the assistant without asking. The rule is strict and positive: the whole line
// is split into plain commands (joined by ;  &&  ||  or a pipe), every one must be on the allow-list, and nothing else
// of the shell is accepted: no substitution, no variables, no globs, no redirect except to /dev/null or to the other
// stream.

var harmlessRedirect2 = regexp.MustCompile(`\s\d*>+\s*/dev/null|\s\d*>&\d`)

// versionProbes are programs that may be asked for their version, and nothing else.
var versionProbes = map[string]bool{"node": true, "npm": true, "python": true, "python3": true, "pip": true, "pip3": true, "go": true,
	"java": true, "php": true, "ruby": true, "nginx": true, "apache2": true, "httpd": true, "mysql": true, "psql": true, "redis-cli": true,
	"docker": true, "git": true, "brew": true, "openssl": true, "curl": true, "wget": true, "ssh": true, "make": true, "gcc": true, "cargo": true}

// filters read the output of the command before them in a pipeline and take no file.
var pipeFilters = map[string]bool{"grep": true, "egrep": true, "fgrep": true, "sort": true, "uniq": true, "head": true, "tail": true,
	"wc": true, "cut": true, "tr": true, "column": true}

var filterArg = regexp.MustCompile(`^(-[A-Za-z0-9]+|[0-9]+|[^/.~\s-][^\s]{0,40})$`)

type roSegment struct {
	tokens []string
	piped  bool
}

// splitChain splits a line into its plain commands. ok is false for anything that is not plain.
func splitChain(cmd string) (segs []roSegment, ok bool) {
	cmd = harmlessRedirect2.ReplaceAllString(" "+cmd, " ")
	var tokens []string
	var cur strings.Builder
	has := false
	var quote rune
	piped := false
	endToken := func() {
		if has || cur.Len() > 0 {
			tokens = append(tokens, cur.String())
		}
		cur.Reset()
		has = false
	}
	endSeg := func(nextPiped bool) bool {
		endToken()
		if len(tokens) == 0 {
			return false
		}
		segs = append(segs, roSegment{tokens: tokens, piped: piped})
		tokens, piped = nil, nextPiped
		return true
	}
	rs := []rune(cmd)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		if quote != 0 {
			switch {
			case c == quote:
				quote = 0
			case c == '$' || c == '`' || c == '\\' || c == '\n' || c == '\r':
				return nil, false
			default:
				cur.WriteRune(c)
			}
			continue
		}
		switch {
		case c == '"' || c == '\'':
			quote, has = c, true
		case c == ' ' || c == '\t':
			endToken()
		case c == ';':
			if !endSeg(false) {
				return nil, false
			}
		case c == '|':
			if i+1 < len(rs) && rs[i+1] == '|' {
				i++
				if !endSeg(false) {
					return nil, false
				}
			} else if !endSeg(true) {
				return nil, false
			}
		case c == '&':
			if i+1 < len(rs) && rs[i+1] == '&' {
				i++
				if !endSeg(false) {
					return nil, false
				}
			} else {
				return nil, false
			}
		case strings.ContainsRune("<>$`(){}*?!\\#\n\r", c):
			return nil, false
		case c == '~':
			if cur.Len() != 0 || (i+1 < len(rs) && rs[i+1] != '/' && rs[i+1] != ' ') {
				return nil, false
			}
			cur.WriteRune(c)
		default:
			cur.WriteRune(c)
		}
	}
	if quote != 0 || !endSeg(false) {
		return nil, false
	}
	return segs, true
}

// readOnlySegment judges one plain command of a chain.
func readOnlySegment(s roSegment) bool {
	name, args := s.tokens[0], s.tokens[1:]
	if strings.ContainsAny(name, "/~") { // a program given by path is not on the list
		return false
	}
	if versionProbes[name] && len(args) == 1 {
		switch args[0] {
		case "--version", "-v", "-V", "version", "-version":
			return true
		}
	}
	switch name {
	case "echo":
		return true
	case "which", "whereis", "pgrep", "pidof":
		for _, a := range args {
			if !(strings.HasPrefix(a, "-") && len(a) <= 4) && !regexp.MustCompile(`^[A-Za-z0-9_.@+-]{1,60}$`).MatchString(a) {
				return false
			}
			if a == "-k" || a == "--signal" {
				return false
			}
		}
		return len(args) > 0
	case "type":
		return len(args) > 0 && regexp.MustCompile(`^[A-Za-z0-9_.@+-]{1,60}$`).MatchString(args[len(args)-1])
	case "command":
		return len(args) == 2 && args[0] == "-v"
	case "nginx":
		return len(args) == 1 && (args[0] == "-t" || args[0] == "-V" || args[0] == "-v")
	case "brew":
		if len(args) == 0 {
			return false
		}
		switch args[0] {
		case "list", "ls", "info", "outdated", "leaves", "deps":
			return true
		case "services":
			return len(args) == 2 && (args[1] == "list" || args[1] == "info")
		}
		return false
	case "apt", "apt-get":
		return len(args) >= 1 && (args[0] == "list" || args[0] == "show" || args[0] == "policy")
	case "dpkg":
		return len(args) >= 1 && (args[0] == "-l" || args[0] == "--list" || args[0] == "-s" || args[0] == "--status")
	case "rpm":
		return len(args) >= 1 && (args[0] == "-q" || args[0] == "-qa" || args[0] == "-qi")
	case "docker":
		return len(args) >= 1 && (args[0] == "ps" || args[0] == "images" || args[0] == "version")
	case "git":
		return len(args) >= 1 && (args[0] == "status" || args[0] == "branch" || args[0] == "log" || args[0] == "diff" || args[0] == "rev-parse" || (args[0] == "remote" && len(args) == 2 && args[1] == "-v"))
	case "systemctl":
		if len(args) >= 1 && (args[0] == "list-units" || args[0] == "list-unit-files" || args[0] == "is-enabled") {
			return true
		}
	case "service":
		return len(args) == 2 && args[1] == "status"
	}
	if s.piped && pipeFilters[name] {
		for _, a := range args {
			if !filterArg.MatchString(a) || a == "-r" || a == "-R" || strings.HasPrefix(a, "--include") || strings.HasPrefix(a, "--file") {
				return false
			}
		}
		return true
	}
	for _, t := range s.tokens {
		if strings.ContainsAny(t, " \t") { // a quoted argument with a space is only understood by echo and the filters
			return false
		}
	}
	return readOnlyOne(strings.Join(s.tokens, " "))
}

// ReadOnlyAllowed reports whether a line only reads: every plain command in it is on the allow-list, and it uses nothing
// else of the shell. Anything that looks like a secret's path is refused.
func ReadOnlyAllowed(cmd string) bool {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" || len(cmd) > 400 || autoDeny.MatchString(cmd) {
		return false
	}
	segs, ok := splitChain(cmd)
	if !ok || len(segs) > 6 {
		return false
	}
	for _, s := range segs {
		if !readOnlySegment(s) {
			return false
		}
	}
	return true
}
