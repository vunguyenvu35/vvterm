package agentx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vvterm/internal/domain/assistant"
)

func TestAntigravityModelsAndSignInComeFromAgyModels(t *testing.T) {
	ok := fakeCLI(t, "agy", `case "$1" in --version) echo "1.4.10";; --help) echo "--print --output-format --settings --model";; models) printf 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\n';; esac`)
	a := &Antigravity{Bin: ok}
	ms, err := a.Models(context.Background())
	if err != nil || len(ms) != 2 || ms[0].ID != "gemini-3.8-flash-high" || ms[1].Name != "Claude Sonnet 5.5 (Low)" {
		t.Fatalf("%v %+v", err, ms)
	}
	if st := a.Detect(context.Background()); st.State != assistant.StateReady || st.Version != "1.4.10" {
		t.Fatalf("%+v", st)
	}
	out := fakeCLI(t, "agy", `case "$1" in --version) echo "1.4.10";; --help) echo "--print --output-format --settings --model";; models) echo "not logged in" >&2; exit 1;; esac`)
	if st := (&Antigravity{Bin: out}).Detect(context.Background()); st.State != assistant.StateNeedsSignIn || st.Hint != "agy" {
		t.Fatalf("%+v", st)
	}
	old := fakeCLI(t, "agy", `case "$1" in --version) echo "0.1";; --help) echo "--print";; esac`)
	if st := (&Antigravity{Bin: old}).Detect(context.Background()); st.State != assistant.StateUnsupported {
		t.Fatalf("%+v", st)
	}
}

func TestAntigravityRunsWithDenyRulesAndTreatsARunToolAsAViolation(t *testing.T) {
	rec := filepath.Join(t.TempDir(), "rec")
	say := func(events string) string {
		return fakeCLI(t, "agy", `printf 'ARG:%s\n' "$@" > `+rec+`; pwd >> `+rec+`
`+events)
	}
	ev := func(s string) string { return "echo '" + s + "'\n" }
	text := ev(`{"event":"step_update","step_update":{"step_type":"agent_response","state":"ACTIVE","text_delta":"hello"}}`) + ev(`{"event":"result","result":{"status":"SUCCESS","response":"hello\n"}}`)
	var chunks []string
	out, err := (&Antigravity{Bin: say(text)}).Ask(context.Background(), req(t, "q"), func(s string) { chunks = append(chunks, s) })
	if err != nil || out != "hello" || len(chunks) != 1 {
		t.Fatalf("%q %v %v", out, err, chunks)
	}
	b, _ := os.ReadFile(rec)
	got := string(b)
	for _, want := range []string{"ARG:--settings", `"deny":["command(*)","mcp(*)"`, `"allow":[]`, "ARG:--print", "vvterm-agent-"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	// a tool that ran is a violation
	ran := say(ev(`{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}`) + ev(`{"event":"step_update","step_update":{"step_type":"tool","state":"DONE","tool_name":"run_command"}}`) + text)
	if _, err := (&Antigravity{Bin: ran}).Ask(context.Background(), req(t, "q"), nil); !errors.Is(err, ErrToolUse) {
		t.Fatalf("got %v", err)
	}
	// a refused attempt followed by an answer is fine; a refused attempt and nothing else is "denied"
	refused := ev(`{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}`) + ev(`{"event":"step_update","step_update":{"step_type":"tool","state":"ERROR","tool_name":"run_command"}}`)
	if out, err := (&Antigravity{Bin: say(refused + text)}).Ask(context.Background(), req(t, "q"), nil); err != nil || out != "hello" {
		t.Fatalf("%q %v", out, err)
	}
	if _, err := (&Antigravity{Bin: say(refused + "echo 'jetski: no output produced - a tool was auto-denied'\n")}).Ask(context.Background(), req(t, "q"), nil); !errors.Is(err, ErrToolDenied) {
		t.Fatalf("got %v", err)
	}
	// the isolation self-test: refused attempts prove the tools are out of reach, a tool that ran fails it
	if err := (&Antigravity{Bin: say(refused + "echo 'x'\n")}).Verify(context.Background()); err != nil {
		t.Fatalf("a refused attempt must pass the self-test: %v", err)
	}
	if err := (&Antigravity{Bin: ran}).Verify(context.Background()); err == nil {
		t.Fatal("a tool that ran must fail the self-test")
	}
	if _, ok := any(&Antigravity{}).(interface{ SupportsImages() bool }); ok {
		t.Fatal("Antigravity takes no pictures here")
	}
}
