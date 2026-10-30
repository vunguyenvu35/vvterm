package usecase

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"vvterm/internal/domain/secretpolicy"
)

// maxHostHistory bounds what one host can put in memory.
const maxHostHistory = 2000

// historyCommand reads the tail of the shell history files of the account. sh is named because the login shell
// of the account may be fish or csh.
const historyCommand = `sh -c 'for f in ~/.zsh_history ~/.bash_history; do [ -r "$f" ] && tail -n 3000 "$f"; done'`

// HostHistory returns the commands in the shell history of a terminal session, newest first, for the command
// suggestions: the history of the server for an SSH session, of this computer for the local terminal. It is only
// held in memory by the page, and a command that holds a secret is left out. The history of this computer is the
// user's own files and is read whenever suggestions are on; the history of a server is only read when the user
// turned on Suggest from the host's shell history. It fails quietly (an error) where the server does not allow it.
func (s *SessionService) HostHistory(sid string) ([]string, error) {
	s.c.setMu.Lock()
	suggest, fromHosts := s.c.settings.Suggest, s.c.settings.SuggestHost
	s.c.setMu.Unlock()
	if !suggest {
		return nil, errors.New("command suggestions are off")
	}
	sess, err := s.get(sid)
	if err != nil {
		return nil, err
	}
	if sess.hostID == LocalHostID {
		return localHistory(), nil
	}
	if !fromHosts {
		return nil, errors.New("reading the shell history of a host is off")
	}
	sess.mu.Lock()
	cl := sess.client
	sess.mu.Unlock()
	if cl == nil {
		return nil, errors.New("this session has no SSH connection")
	}
	out, err := cl.Exec(historyCommand, 5*time.Second)
	if err != nil && out == "" {
		return nil, err
	}
	return parseShellHistory(out), nil
}

// zshExtended is the prefix of an entry of an extended zsh history: ": 1690000000:0;command".
var zshExtended = regexp.MustCompile(`^: \d+:\d+;`)

// parseShellHistory turns the text of bash and zsh history files (oldest first) into single-line commands, newest
// first and without repeats. A command that spans lines, one that is too long to be useful and one that holds a
// secret are dropped.
func parseShellHistory(raw string) []string {
	if len(raw) > 4<<20 {
		raw = raw[len(raw)-4<<20:]
	}
	var cmds []string
	continued := false
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		wasContinued := continued
		continued = strings.HasSuffix(line, `\`)
		if wasContinued || continued {
			continue
		}
		line = strings.TrimSpace(zshExtended.ReplaceAllString(line, ""))
		if len(line) < 2 || len(line) > 200 || strings.HasPrefix(line, "#") {
			continue
		}
		cmds = append(cmds, line)
	}
	guard := secretpolicy.Guard{}
	seen := map[string]bool{}
	out := []string{}
	for i := len(cmds) - 1; i >= 0 && len(out) < maxHostHistory; i-- {
		c := cmds[i]
		if seen[c] {
			continue
		}
		seen[c] = true
		if guard.Contains(c) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// historyTailBytes bounds how much of each history file is read.
const historyTailBytes = 512 << 10

// localHistory reads the shell history files in the home folder of this computer (the local terminal).
func localHistory() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return []string{}
	}
	return historyFromFiles(home)
}

// historyFromFiles is the zsh and bash history files of a home folder, read from their tails, as one list.
func historyFromFiles(home string) []string {
	var raw strings.Builder
	for _, name := range []string{".zsh_history", ".bash_history"} {
		if tail := readTail(filepath.Join(home, name), historyTailBytes); tail != "" {
			raw.WriteString(tail)
			raw.WriteString("\n")
		}
	}
	return parseShellHistory(raw.String())
}

// readTail returns the last max bytes of a file as text (” when it cannot be read), starting at a line.
func readTail(path string, max int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return ""
	}
	cut := st.Size() > max
	if cut {
		if _, err := f.Seek(st.Size()-max, io.SeekStart); err != nil {
			return ""
		}
	}
	b, err := io.ReadAll(io.LimitReader(f, max))
	if err != nil {
		return ""
	}
	text := string(b)
	if cut {
		if i := strings.IndexByte(text, '\n'); i >= 0 {
			text = text[i+1:] // the first line is probably cut
		}
	}
	return text
}
