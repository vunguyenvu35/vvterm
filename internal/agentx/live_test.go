package agentx

import (
	"context"
	"os"
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
// Antigravity's search_web tool cannot be turned off (every deny rule tried was ignored), so the isolation self-test must
// fail and the provider cannot be enabled. If a future version honours a rule, this test starts to fail: update the adapter.
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
	err := a.Verify(context.Background())
	t.Logf("isolation self-test: %v", err)
	if err == nil {
		t.Fatal("Antigravity must not pass the self-test while its web search cannot be turned off")
	}
}
