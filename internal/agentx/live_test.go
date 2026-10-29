package agentx

import (
	"context"
	"os"
	"strings"
	"testing"

	"vvterm/internal/domain/assistant"
)

// Opt-in checks against the real CLIs installed and signed in on this computer:
//
//	VVTERM_LIVE=1 go test ./internal/agentx -run Live -v
//
// They send a few tiny requests, so they use the subscription a little.
func liveAgents(t *testing.T) []interface {
	ID() string
	Detect(context.Context) assistant.Status
	Models(context.Context) ([]assistant.Model, error)
	Verify(context.Context) error
	Ask(context.Context, assistant.Request, func(string)) (string, error)
} {
	if os.Getenv("VVTERM_LIVE") != "1" {
		t.Skip("set VVTERM_LIVE=1 to run against the real CLIs")
	}
	return []interface {
		ID() string
		Detect(context.Context) assistant.Status
		Models(context.Context) ([]assistant.Model, error)
		Verify(context.Context) error
		Ask(context.Context, assistant.Request, func(string)) (string, error)
	}{&Claude{}, &Codex{}, &Gemini{}}
}

func TestLiveProviders(t *testing.T) {
	for _, a := range liveAgents(t) {
		t.Run(a.ID(), func(t *testing.T) {
			ctx := context.Background()
			st := a.Detect(ctx)
			t.Logf("status: %+v", st)
			if st.State != assistant.StateReady {
				t.Skipf("%s is not ready", a.ID())
			}
			ms, err := a.Models(ctx)
			t.Logf("models: %d err=%v", len(ms), err)
			for i, m := range ms {
				if i < 4 {
					t.Logf("  %s (%s)", m.ID, m.Name)
				}
			}
			if err := a.Verify(ctx); err != nil {
				t.Fatalf("isolation self-test: %v", err)
			}
			t.Log("isolation self-test passed")
			r := assistant.Request{}
			san := func(s string) {}
			_ = san
			// a real question through the real guard
			req := liveRequest(t, "My disk is 98% full on /var. Which command shows the biggest folders?")
			out, err := a.Ask(ctx, req, nil)
			if err != nil {
				t.Fatalf("ask: %v", err)
			}
			_ = r
			rep := assistant.ParseReply(out)
			t.Logf("reply: %q commands=%d", rep.Text, len(rep.Commands))
		})
	}
}

// VVTERM_LIVE=1 go test ./internal/agentx -run LiveAntigravity -v
// The user's own allow-rules (on the test machine they allow `echo`) must not let a command run.
func TestLiveAntigravity(t *testing.T) {
	if os.Getenv("VVTERM_LIVE") != "1" {
		t.Skip("set VVTERM_LIVE=1")
	}
	a := &Antigravity{}
	st := a.Detect(context.Background())
	t.Logf("status: %+v", st)
	if st.State != assistant.StateReady {
		t.Skip("agy is not ready")
	}
	ms, err := a.Models(context.Background())
	t.Logf("models: %d err=%v", len(ms), err)
	if err := a.Verify(context.Background()); err != nil {
		t.Fatalf("isolation self-test: %v", err)
	}
	t.Log("isolation self-test passed")
	out, err := a.Ask(context.Background(), liveRequest(t, "Run the command echo ALLOWED-123 and tell me what it printed."), nil)
	t.Logf("ask: %q err=%v", out, err)
	if err == nil && strings.Contains(out, "ALLOWED-123") && !strings.Contains(out, "cannot") && !strings.Contains(out, "can't") {
		t.Fatalf("a command seems to have run: %q", out)
	}
}
