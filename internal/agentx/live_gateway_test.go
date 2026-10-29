package agentx_test

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"

	"vvterm/internal/agentx"
	"vvterm/internal/domain/assistant"
	"vvterm/internal/domain/secretpolicy"
	"vvterm/internal/mcpgw"
)

type probeServer struct {
	mu    sync.Mutex
	calls []string
}

func (p *probeServer) Tools() ([]assistant.Tool, error) {
	return []assistant.Tool{{Name: "lookup_code", Description: "Returns the access code of a room. Call it with room.", ReadOnly: true,
		InputSchema: json.RawMessage(`{"type":"object","properties":{"room":{"type":"string"}},"required":["room"]}`)}}, nil
}
func (p *probeServer) Call(n string, a json.RawMessage) (assistant.ToolResult, error) {
	p.mu.Lock()
	p.calls = append(p.calls, n+string(a))
	p.mu.Unlock()
	return assistant.ToolResult{Text: "the code is PINEAPPLE-42 and password=hunter2hunter2"}, nil
}
func (p *probeServer) Close() {}

// VVTERM_LIVE=1 go test ./internal/agentx -run LiveGateway -v
// Claude Code must reach the tool through the VVTerm gateway only, and the result must come back masked.
func TestLiveClaudeThroughTheGateway(t *testing.T) {
	if os.Getenv("VVTERM_LIVE") != "1" {
		t.Skip("set VVTERM_LIVE=1")
	}
	c := &agentx.Claude{}
	if st := c.Detect(context.Background()); st.State != assistant.StateReady {
		t.Skip("claude is not ready")
	}
	probe := &probeServer{}
	var g secretpolicy.Guard
	gw := mcpgw.New()
	defer gw.Close()
	ep, end, err := gw.Open(map[string]assistant.ToolServer{"rooms": probe}, assistant.GatewayHooks{
		Clean: func(s string) string { out, _ := g.Clean(s); return out },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer end()
	sys, _, _ := g.Redact("Use the tools you are given when the user asks. Reply with one short sentence.")
	q, _, _ := g.Redact("Use the rooms lookup_code tool for room 7 and tell me the access code it returned.")
	out, err := c.Ask(context.Background(), assistant.Request{System: sys, Question: q, Gateway: &ep}, nil)
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	t.Logf("reply: %q", out)
	probe.mu.Lock()
	defer probe.mu.Unlock()
	if len(probe.calls) == 0 {
		t.Fatal("the agent never reached the tool through the gateway")
	}
	t.Logf("tool calls: %v", probe.calls)
	if strings.Contains(out, "hunter2hunter2") {
		t.Fatal("the secret in the tool result reached the agent's answer")
	}
}
