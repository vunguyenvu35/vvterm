package sqlitedb

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vvterm/internal/domain"
)

func openLog(t *testing.T) *ActivityLog {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d.ActivityLog()
}

func add(t *testing.T, a *ActivityLog, kind, label, msg string, ok bool) {
	t.Helper()
	if err := a.Add(domain.ActivityEntry{Kind: kind, HostLabel: label, Message: msg, OK: ok}); err != nil {
		t.Fatal(err)
	}
}

func TestActivityListsNewestFirstAndRoundTrips(t *testing.T) {
	a := openLog(t)
	if got, err := a.List(domain.ActivityFilter{}); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("an empty log is an empty list, not null: %v %v", got, err)
	}
	add(t, a, domain.ActConnect, "web", "Connected", true)
	add(t, a, domain.ActDisconnect, "web", "Connection lost: eof", false)
	got, err := a.List(domain.ActivityFilter{})
	if err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
	if got[0].Message != "Connection lost: eof" || got[0].OK || got[0].Kind != domain.ActDisconnect || got[0].HostLabel != "web" {
		t.Fatalf("%+v", got[0])
	}
	if got[1].ID >= got[0].ID || time.Since(got[0].At) > time.Minute || got[0].At.IsZero() {
		t.Fatalf("%+v %+v", got[0], got[1])
	}
}

func TestActivityFilters(t *testing.T) {
	a := openLog(t)
	add(t, a, domain.ActConnect, "web", "Connected to 10.0.0.1:22", true)
	add(t, a, domain.ActTransfer, "web", "Uploaded 3 files", true)
	add(t, a, domain.ActForward, "db", "Started local forward", true)
	add(t, a, domain.ActVault, "", "100% sure: Vault_unlocked", true)
	msgs := func(f domain.ActivityFilter) string {
		got, err := a.List(f)
		if err != nil {
			t.Fatal(err)
		}
		var m []string
		for _, e := range got {
			m = append(m, e.Message)
		}
		return strings.Join(m, "|")
	}
	if got := msgs(domain.ActivityFilter{Kinds: []string{domain.ActConnect, domain.ActTransfer}}); got != "Uploaded 3 files|Connected to 10.0.0.1:22" {
		t.Fatal(got)
	}
	if got := msgs(domain.ActivityFilter{Query: "forward"}); got != "Started local forward" {
		t.Fatal(got)
	}
	if got := msgs(domain.ActivityFilter{Query: "DB"}); got != "Started local forward" {
		t.Fatalf("the host label is searched too, ignoring case: %q", got)
	}
	if got := msgs(domain.ActivityFilter{Query: "100%"}); got != "100% sure: Vault_unlocked" {
		t.Fatalf("%% is a literal, not a wildcard: %q", got)
	}
	if got := msgs(domain.ActivityFilter{Query: "_"}); got != "100% sure: Vault_unlocked" {
		t.Fatalf("_ is a literal too: %q", got)
	}
	if got := msgs(domain.ActivityFilter{Query: "'; DROP TABLE activity_log; --"}); got != "" {
		t.Fatal(got)
	}
	if got := msgs(domain.ActivityFilter{Kinds: []string{domain.ActSync}}); got != "" {
		t.Fatal(got)
	}
	if got, _ := a.List(domain.ActivityFilter{Limit: 2}); len(got) != 2 {
		t.Fatalf("limit: %d", len(got))
	}
	if got, _ := a.List(domain.ActivityFilter{}); len(got) != 4 {
		t.Fatal("the injection attempt must not have damaged anything")
	}
}

func TestActivityKeepsOnlyTheNewestRows(t *testing.T) {
	old := maxActivityRows
	maxActivityRows = 20
	t.Cleanup(func() { maxActivityRows = old })
	a := openLog(t)
	for i := 0; i < 50; i++ {
		add(t, a, domain.ActConnect, "h", "line "+strings.Repeat("x", i%3), true)
	}
	got, _ := a.List(domain.ActivityFilter{})
	if len(got) != 20 {
		t.Fatalf("kept %d, want 20", len(got))
	}
}

func TestActivityClearAndValidation(t *testing.T) {
	a := openLog(t)
	add(t, a, domain.ActConnect, "h", "x", true)
	if err := a.Clear(); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.List(domain.ActivityFilter{}); len(got) != 0 {
		t.Fatal("cleared")
	}
	if err := a.Add(domain.ActivityEntry{Kind: "nonsense", Message: "x"}); err == nil {
		t.Fatal("unknown kind")
	}
	if err := a.Add(domain.ActivityEntry{Kind: domain.ActConnect, Message: "  \n "}); err == nil {
		t.Fatal("empty message")
	}
	add(t, a, domain.ActConnect, "h", "two\nlines\x00 here", true)
	long := strings.Repeat("é", 800)
	add(t, a, domain.ActConnect, "h", long, true)
	got, _ := a.List(domain.ActivityFilter{})
	if got[1].Message != "two lines here" {
		t.Fatalf("one line, no control characters: %q", got[1].Message)
	}
	if n := len([]rune(got[0].Message)); n != domain.MaxActivityMessage || !strings.HasSuffix(got[0].Message, "…") {
		t.Fatalf("bounded at %d: %d", domain.MaxActivityMessage, n)
	}
}
