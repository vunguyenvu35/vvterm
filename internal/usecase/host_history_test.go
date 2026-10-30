package usecase

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseShellHistoryKeepsNewestFirstWithoutRepeats(t *testing.T) {
	raw := strings.Join([]string{
		": 1690000001:0;ls -la",
		": 1690000002:0;git status",
		"docker ps",
		"ls -la",
		"# a comment",
		"x",
	}, "\n")
	got := parseShellHistory(raw)
	want := []string{"ls -la", "docker ps", "git status"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseShellHistoryDropsMultiLineAndSecretsAndHugeLines(t *testing.T) {
	raw := strings.Join([]string{
		"echo one \\",
		"  two",
		"export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		"curl -H 'Authorization: Bearer abcdef0123456789abcdef0123456789abcdef' https://x",
		strings.Repeat("a", 300),
		"uptime",
	}, "\n")
	got := parseShellHistory(raw)
	if !reflect.DeepEqual(got, []string{"uptime"}) {
		t.Fatalf("got %v", got)
	}
}

func TestHostHistoryIsOffWhenSuggestionsAreOff(t *testing.T) {
	h := newHarness(t).unlocked(t)
	set := h.app.Settings.Get()
	set.Suggest = false
	if _, err := h.app.Settings.Save(set); err != nil {
		t.Fatal(err)
	}
	if _, err := h.app.Session.HostHistory("nope"); err == nil || !strings.Contains(err.Error(), "off") {
		t.Fatalf("must refuse while suggestions are off: %v", err)
	}
}

func TestSuggestSettingsDefaultAndPersist(t *testing.T) {
	h := newHarness(t).unlocked(t)
	got := h.app.Settings.Get()
	if !got.Suggest || got.SuggestHost {
		t.Fatalf("suggestions are on and the host history is off by default: %+v", got)
	}
	got.Suggest, got.SuggestHost = false, true
	saved, err := h.app.Settings.Save(got)
	if err != nil || saved.Suggest || !saved.SuggestHost {
		t.Fatalf("%+v %v", saved, err)
	}
	// with suggestions off the host history is not read, whatever the second switch says
	if _, err := h.app.Session.HostHistory("nope"); err == nil || !strings.Contains(err.Error(), "off") {
		t.Fatalf("%v", err)
	}
}

func TestHistoryFromFilesReadsZshAndBashNewestFirst(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, ".zsh_history"), []byte(": 1690000001:0;cd Data/projects/me\n: 1690000002:0;yarn dev\n"), 0o600)
	os.WriteFile(filepath.Join(home, ".bash_history"), []byte("ls -la\ncd Data/projects/me\n"), 0o600)
	got := historyFromFiles(home)
	want := []string{"cd Data/projects/me", "ls -la", "yarn dev"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if got := historyFromFiles(t.TempDir()); len(got) != 0 {
		t.Fatalf("no history files: %v", got)
	}
}

func TestReadTailStartsAtALineAndKeepsTheEnd(t *testing.T) {
	p := filepath.Join(t.TempDir(), "h")
	os.WriteFile(p, []byte("first line\nsecond line\nthird line\n"), 0o600)
	if got := readTail(p, 1000); got != "first line\nsecond line\nthird line\n" {
		t.Fatalf("whole file: %q", got)
	}
	got := readTail(p, 18) // cuts inside the second line
	if got != "third line\n" {
		t.Fatalf("tail: %q", got)
	}
	if readTail(filepath.Join(t.TempDir(), "missing"), 10) != "" {
		t.Fatal("a missing file is empty")
	}
}
