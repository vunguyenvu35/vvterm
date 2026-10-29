package agentx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vvterm/internal/domain/assistant"
	"vvterm/internal/domain/secretpolicy"
)

// fakeCLI writes an executable shell script. The script appends what it saw to rec.
func fakeCLI(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func req(t *testing.T, q string) assistant.Request {
	t.Helper()
	var g secretpolicy.Guard
	sys, _, _ := g.Redact("system")
	ctx, _, _ := g.Redact("screen text")
	qq, _, _ := g.Redact(q)
	return assistant.Request{System: sys, Context: ctx, Question: qq}
}

const claudeHelp = `--tools --strict-mcp-config --disable-slash-commands --no-session-persistence --output-format --system-prompt --restricted`

func TestClaudeAskIsRunIsolatedAndStreams(t *testing.T) {
	rec := filepath.Join(t.TempDir(), "rec")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	t.Setenv("VVTERM_TOKEN", "abc")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "zzz")
	t.Setenv("ANTHROPIC_API_KEY", "sk-should-not-pass")
	bin := fakeCLI(t, "claude", `
case "$1" in --version) echo "9.9.9 (Claude Code)"; exit 0;; --help) echo "`+claudeHelp+`"; exit 0;; esac
{ pwd; echo "files:$(ls -A | wc -l | tr -d " ")"; env; printf 'ARG:%s\n' "$@"; echo "STDIN:$(cat)"; } > `+rec+`
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"hello"}'
`)
	var got []string
	out, err := (&Claude{Bin: bin}).Ask(context.Background(), req(t, "why is it slow"), func(s string) { got = append(got, s) })
	if err != nil || out != "hello" || strings.Join(got, "|") != "hel|lo" {
		t.Fatalf("out=%q err=%v chunks=%v", out, err, got)
	}
	b, _ := os.ReadFile(rec)
	r := string(b)
	cwd := strings.SplitN(r, "\n", 2)[0]
	if !strings.Contains(filepath.Base(cwd), "vvterm-agent-") || !strings.Contains(r, "files:0") {
		t.Fatalf("agent must run in a fresh empty directory, got %q", cwd)
	}
	if _, err := os.Stat(cwd); err == nil {
		t.Fatal("the temporary directory must be removed afterwards")
	}
	for _, leak := range []string{"SSH_AUTH_SOCK", "VVTERM_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "sk-should-not-pass"} {
		if strings.Contains(r, leak) {
			t.Errorf("environment leaked %s", leak)
		}
	}
	for _, want := range []string{"ARG:--tools\nARG:\nARG:--strict-mcp-config", "ARG:--disable-slash-commands", "ARG:--restricted", "ARG:--no-session-persistence", "STDIN:", "screen text", "why is it slow"} {
		if !strings.Contains(r, want) {
			t.Errorf("missing %q in\n%s", want, r)
		}
	}
	if strings.Contains(r, "ARG:--mcp-config") {
		t.Error("no gateway, so no MCP config")
	}
}

func TestClaudeToolUseIsStopped(t *testing.T) {
	bin := fakeCLI(t, "claude", `
case "$1" in --help) echo "`+claudeHelp+`"; exit 0;; esac
cat >/dev/null
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}'
echo '{"type":"result","result":"done"}'
`)
	if _, err := (&Claude{Bin: bin}).Ask(context.Background(), req(t, "x"), nil); !errors.Is(err, ErrToolUse) {
		t.Fatalf("got %v", err)
	}
}

func TestClaudeGatewayIsTheOnlyToolChannel(t *testing.T) {
	rec := filepath.Join(t.TempDir(), "rec")
	bin := fakeCLI(t, "claude", `
case "$1" in --help) echo "`+claudeHelp+`"; exit 0;; esac
printf 'ARG:%s\n' "$@" > `+rec+`; cat >/dev/null
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__vvterm__terminal_read"}]}}'
echo '{"type":"result","result":"ok"}'
`)
	r := req(t, "x")
	r.Gateway = &assistant.Gateway{URL: "http://127.0.0.1:1/mcp", Token: "tok"}
	if out, err := (&Claude{Bin: bin}).Ask(context.Background(), r, nil); err != nil || out != "ok" {
		t.Fatalf("%q %v", out, err)
	}
	b, _ := os.ReadFile(rec)
	if !strings.Contains(string(b), "--strict-mcp-config") || !strings.Contains(string(b), `"url":"http://127.0.0.1:1/mcp"`) || !strings.Contains(string(b), "ARG:mcp__vvterm") {
		t.Fatalf("%s", b)
	}
}

func TestClaudeModelsComeFromTheProvider(t *testing.T) {
	bin := fakeCLI(t, "claude", `
case "$1" in --help) echo "`+claudeHelp+`"; exit 0;; esac
cat >/dev/null
echo '{"type":"control_response","response":{"subtype":"success","request_id":"vvterm-models","response":{"models":[{"value":"default","displayName":"Default","description":"d"},{"value":"opus","displayName":"Opus"}]}}}'
`)
	ms, err := (&Claude{Bin: bin}).Models(context.Background())
	if err != nil || len(ms) != 2 || ms[1].ID != "opus" || ms[1].Name != "Opus" {
		t.Fatalf("%v %+v", err, ms)
	}
}

func TestClaudeDetect(t *testing.T) {
	ok := fakeCLI(t, "claude", `case "$1" in --version) echo "2.0.1 (Claude Code)";; --help) echo "`+claudeHelp+`";; auth) echo '{"loggedIn":true}';; esac`)
	if st := (&Claude{Bin: ok}).Detect(context.Background()); st.State != assistant.StateReady || st.Version != "2.0.1" {
		t.Fatalf("%+v", st)
	}
	out := fakeCLI(t, "claude", `case "$1" in --version) echo "2.0.1";; --help) echo "`+claudeHelp+`";; auth) echo '{"loggedIn":false}';; esac`)
	if st := (&Claude{Bin: out}).Detect(context.Background()); st.State != assistant.StateNeedsSignIn || st.Hint == "" {
		t.Fatalf("%+v", st)
	}
	old := fakeCLI(t, "claude", `case "$1" in --version) echo "0.1.0";; --help) echo "--output-format";; esac`)
	if st := (&Claude{Bin: old}).Detect(context.Background()); st.State != assistant.StateUnsupported {
		t.Fatalf("%+v", st)
	}
	if st := (&Claude{Bin: filepath.Join(t.TempDir(), "nope")}).Detect(context.Background()); st.State != assistant.StateReady && st.State != assistant.StateNotFound && st.State != assistant.StateUnsupported {
		t.Fatalf("%+v", st)
	}
}

func TestCodexToolEventsAreStoppedAndModelsAreRead(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(`{"models":[
	  {"slug":"hidden","display_name":"Hidden","visibility":"hide","priority":1},
	  {"slug":"b","display_name":"B","visibility":"list","priority":9},
	  {"slug":"a","display_name":"A","visibility":"list","priority":2}]}`), 0o600)
	os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"secret":"never read"}`), 0o600)
	ms, err := (&Codex{Home: home}).Models(context.Background())
	if err != nil || len(ms) != 2 || ms[0].ID != "a" || ms[1].ID != "b" {
		t.Fatalf("%v %+v", err, ms)
	}
	rec := filepath.Join(t.TempDir(), "rec")
	bin := fakeCLI(t, "codex", `printf 'ARG:%s\n' "$@" > `+rec+`; cat >/dev/null
echo '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"x"}}'`)
	if _, err := (&Codex{Bin: bin}).Ask(context.Background(), req(t, "x"), nil); !errors.Is(err, ErrToolUse) {
		t.Fatalf("got %v", err)
	}
	b, _ := os.ReadFile(rec)
	for _, want := range []string{"ARG:--disable\nARG:shell_tool", "ARG:--ignore-user-config", "ARG:read-only", "ARG:--ephemeral"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("missing %q", want)
		}
	}
	ok := fakeCLI(t, "codex", `cat >/dev/null
echo '{"type":"item.completed","item":{"type":"reasoning"}}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}'`)
	if out, err := (&Codex{Bin: ok}).Ask(context.Background(), req(t, "x"), nil); err != nil || out != "answer" {
		t.Fatalf("%q %v", out, err)
	}
}

func TestGeminiParsesJSONAndRefusesToolCalls(t *testing.T) {
	ok := fakeCLI(t, "gemini", `cat >/dev/null; echo '{"response":"hi","stats":{"tools":{"totalCalls":0}}}'`)
	if out, err := (&Gemini{Bin: ok}).Ask(context.Background(), req(t, "x"), nil); err != nil || out != "hi" {
		t.Fatalf("%q %v", out, err)
	}
	bad := fakeCLI(t, "gemini", `cat >/dev/null; echo '{"response":"hi","stats":{"tools":{"totalCalls":2}}}'`)
	if _, err := (&Gemini{Bin: bad}).Ask(context.Background(), req(t, "x"), nil); !errors.Is(err, ErrToolUse) {
		t.Fatalf("got %v", err)
	}
	out := fakeCLI(t, "gemini", `cat >/dev/null; echo "Invalid auth method selected." >&2; exit 1`)
	if _, err := (&Gemini{Bin: out}).Ask(context.Background(), req(t, "x"), nil); !errors.Is(err, ErrNeedsSignIn) {
		t.Fatalf("got %v", err)
	}
	if ms, err := (&Gemini{}).Models(context.Background()); err != nil || len(ms) != 0 {
		t.Fatal("Gemini cannot list models; nothing must be invented")
	}
}

func TestVerifyIsolation(t *testing.T) {
	host, _ := os.Hostname()
	good := func(ctx context.Context, r assistant.Request, e func(string)) (string, error) { return "NO TOOLS", nil }
	if err := verifyIsolation(context.Background(), good); err != nil {
		t.Fatal(err)
	}
	leaky := func(ctx context.Context, r assistant.Request, e func(string)) (string, error) { return host, nil }
	if host != "" && len(host) >= 3 && verifyIsolation(context.Background(), leaky) == nil {
		t.Fatal("an agent that knows the hostname must fail the test")
	}
	tools := func(ctx context.Context, r assistant.Request, e func(string)) (string, error) { return "", ErrToolUse }
	if verifyIsolation(context.Background(), tools) == nil {
		t.Fatal("tool use must fail the test")
	}
	broken := func(ctx context.Context, r assistant.Request, e func(string)) (string, error) {
		return "", errors.New("boom")
	}
	if verifyIsolation(context.Background(), broken) == nil {
		t.Fatal("an agent that cannot be tested must not pass")
	}
}

func TestCustomAgentViaStdinAndArg(t *testing.T) {
	bin := fakeCLI(t, "mytool", `if [ "$1" = "--ask" ]; then echo "arg:$2" | head -c 20; else cat | head -c 12; fi; echo`)
	c := &Custom{Cfg: CustomConfig{ID: "my", Name: "My", Command: bin, PromptVia: "stdin"}}
	if out, err := c.Ask(context.Background(), req(t, "q"), nil); err != nil || out == "" {
		t.Fatalf("%q %v", out, err)
	}
	c = &Custom{Cfg: CustomConfig{ID: "my", Name: "My", Command: bin, Args: []string{"--ask", "{prompt}"}, PromptVia: "arg"}}
	if out, err := c.Ask(context.Background(), req(t, "q"), nil); err != nil || !strings.HasPrefix(out, "arg:") {
		t.Fatalf("%q %v", out, err)
	}
	if st := (&Custom{Cfg: CustomConfig{Command: "definitely-not-installed-xyz"}}).Detect(context.Background()); st.State != assistant.StateNotFound {
		t.Fatalf("%+v", st)
	}
}

func TestBaseEnvDropsSecretLookingNames(t *testing.T) {
	t.Setenv("LANG", "en_US.UTF-8")
	t.Setenv("MY_API_TOKEN", "x")
	t.Setenv("CLAUDE_CONFIG_DIR", "/tmp/cfg")
	env := strings.Join(baseEnv("CLAUDE_CONFIG_DIR", "MY_API_TOKEN"), "\n")
	if strings.Contains(env, "MY_API_TOKEN") || !strings.Contains(env, "LANG=") || !strings.Contains(env, "PATH=") {
		t.Fatal(env)
	}
	_ = env
}

func liveRequest(t *testing.T, q string) assistant.Request {
	t.Helper()
	var g secretpolicy.Guard
	sys, _, _ := g.Redact(assistant.SystemPrompt)
	ctx, _, _ := g.Redact("Host: demo (demo.example.com)\nuser@demo:~$ df -h\n/dev/sda1 98% /var")
	qq, _, _ := g.Redact(q)
	return assistant.Request{System: sys, Context: ctx, Question: qq}
}

func TestGeminiDetectReadsTheSelectedSignIn(t *testing.T) {
	bin := fakeCLI(t, "gemini", `case "$1" in --version) echo "0.44.1";; --help) echo "--policy --approval-mode --output-format --extensions";; esac`)
	for _, c := range []struct {
		settings string
		creds    bool
		want     assistant.State
	}{
		{``, false, assistant.StateNeedsSignIn},
		{`{"security":{"auth":{"selectedType":"gateway"}}}`, true, assistant.StateNeedsSignIn},
		{`{"security":{"auth":{"selectedType":"gemini-api-key"}}}`, true, assistant.StateNeedsSignIn},
		{`{"security":{"auth":{"selectedType":"oauth-personal"}}}`, false, assistant.StateNeedsSignIn},
		{`{"security":{"auth":{"selectedType":"oauth-personal"}}}`, true, assistant.StateReady},
		{`{"selectedAuthType":"oauth-personal"}`, true, assistant.StateReady},
	} {
		home := t.TempDir()
		if c.settings != "" {
			os.WriteFile(filepath.Join(home, "settings.json"), []byte(c.settings), 0o600)
		}
		if c.creds {
			os.WriteFile(filepath.Join(home, "oauth_creds.json"), []byte(`{"never":"read"}`), 0o600)
		}
		if st := (&Gemini{Bin: bin, Home: home}).Detect(context.Background()); st.State != c.want {
			t.Errorf("%s creds=%v: got %+v", c.settings, c.creds, st)
		}
	}
}
