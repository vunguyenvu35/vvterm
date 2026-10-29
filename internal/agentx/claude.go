package agentx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"vvterm/internal/domain/assistant"
)

// ErrToolUse is returned when an agent that must have no tools tried to use one. The call is stopped.
var ErrToolUse = assistant.ErrToolUse

// Claude drives Claude Code in print mode.
type Claude struct {
	// Bin overrides the binary (tests); empty means "claude" found on the login PATH.
	Bin string
}

func (c *Claude) ID() string        { return "claude" }
func (c *Claude) Name() string      { return "Claude Code" }
func (c *Claude) SupportsMCP() bool { return true }

func (c *Claude) bin() string {
	if c.Bin != "" {
		return c.Bin
	}
	return findBinary("claude")
}

func (c *Claude) env() []string { return baseEnv("CLAUDE_CONFIG_DIR") }

// requiredFlags are what the isolation needs; a CLI without them is not used.
var claudeRequired = []string{"--tools", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "--system-prompt"}

func (c *Claude) Detect(ctx context.Context) assistant.Status {
	bin := c.bin()
	if bin == "" {
		return assistant.Status{State: assistant.StateNotFound, Detail: "claude was not found", Hint: "Install Claude Code"}
	}
	vout, err := output(bin, 5*time.Second, c.env(), "--version")
	if err != nil {
		return assistant.Status{State: assistant.StateUnsupported, Detail: "claude --version failed"}
	}
	st := assistant.Status{Version: parseVersion(vout)}
	help, _ := output(bin, 5*time.Second, c.env(), "--help")
	for _, f := range claudeRequired {
		if !strings.Contains(help, f) {
			st.State, st.Detail = assistant.StateUnsupported, "this version lacks "+f+", which the isolation needs"
			return st
		}
	}
	if out, err := output(bin, 8*time.Second, c.env(), "auth", "status"); err == nil {
		var s struct {
			LoggedIn bool `json:"loggedIn"`
		}
		if json.Unmarshal([]byte(out), &s) == nil && !s.LoggedIn {
			st.State, st.Detail, st.Hint = assistant.StateNeedsSignIn, "not signed in", "claude auth login"
			return st
		}
	}
	st.State = assistant.StateReady
	return st
}

// isolationArgs are the flags every Claude call gets.
func (c *Claude) isolationArgs(help string) []string {
	a := []string{"--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"}
	if strings.Contains(help, "--restricted") {
		a = append(a, "--restricted") // also ignores the user's settings files (hooks, CLAUDE.md)
	}
	return a
}

func (c *Claude) helpText() string {
	h, _ := output(c.bin(), 5*time.Second, c.env(), "--help")
	return h
}

// Models asks Claude Code itself: its initialize reply lists the models of the signed-in account.
func (c *Claude) Models(ctx context.Context) ([]assistant.Model, error) {
	bin := c.bin()
	if bin == "" {
		return nil, errors.New("claude was not found")
	}
	dir, done, err := tempDir()
	if err != nil {
		return nil, err
	}
	defer done()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var models []assistant.Model
	args := append([]string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"}, c.isolationArgs(c.helpText())...)
	_, err = run(ctx, runOpts{bin: bin, args: args, dir: dir, env: c.env(),
		stdin: `{"type":"control_request","request_id":"vvterm-models","request":{"subtype":"initialize"}}` + "\n",
		onLine: func(line []byte) error {
			var m struct {
				Type     string `json:"type"`
				Response struct {
					RequestID string `json:"request_id"`
					Response  struct {
						Models []struct {
							Value       string `json:"value"`
							DisplayName string `json:"displayName"`
							Description string `json:"description"`
						} `json:"models"`
					} `json:"response"`
				} `json:"response"`
			}
			if json.Unmarshal(line, &m) != nil || m.Type != "control_response" || m.Response.RequestID != "vvterm-models" {
				return nil
			}
			for _, x := range m.Response.Response.Models {
				if x.Value != "" {
					models = append(models, assistant.Model{ID: x.Value, Name: x.DisplayName, Description: x.Description})
				}
			}
			return errStop
		}})
	if len(models) > 0 {
		return models, nil
	}
	if err != nil && !errors.Is(err, errStop) {
		return nil, err
	}
	return nil, errors.New("claude returned no model list")
}

var errStop = errors.New("stop")

func (c *Claude) Verify(ctx context.Context) error { return verifyIsolation(ctx, c.Ask) }

func (c *Claude) Ask(ctx context.Context, r assistant.Request, emit func(string)) (string, error) {
	bin := c.bin()
	if bin == "" {
		return "", errors.New("claude was not found")
	}
	dir, done, err := tempDir()
	if err != nil {
		return "", err
	}
	defer done()
	args := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--system-prompt", r.System.String()}
	args = append(args, c.isolationArgs(c.helpText())...)
	if r.Model != "" {
		args = append(args, "--model", r.Model)
	}
	allowedMCP := ""
	if r.Gateway != nil {
		cfg, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"vvterm": map[string]any{
			"type": "http", "url": r.Gateway.URL, "headers": map[string]string{"Authorization": "Bearer " + r.Gateway.Token}}}})
		args = append(args, "--mcp-config", string(cfg), "--allowedTools", "mcp__vvterm")
		allowedMCP = "mcp__vvterm__"
	}
	var final, streamed strings.Builder
	var isErr bool
	stderr, err := run(ctx, runOpts{bin: bin, args: args, stdin: userPrompt(r, false), dir: dir, env: c.env(),
		onLine: func(line []byte) error {
			var m struct {
				Type    string `json:"type"`
				Result  string `json:"result"`
				IsError bool   `json:"is_error"`
				Event   struct {
					Type  string `json:"type"`
					Delta struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"delta"`
				} `json:"event"`
				Message struct {
					Content []struct {
						Type string `json:"type"`
						Name string `json:"name"`
					} `json:"content"`
				} `json:"message"`
			}
			if json.Unmarshal(line, &m) != nil {
				return nil
			}
			switch m.Type {
			case "stream_event":
				if m.Event.Type == "content_block_delta" && m.Event.Delta.Type == "text_delta" && m.Event.Delta.Text != "" {
					streamed.WriteString(m.Event.Delta.Text)
					if emit != nil {
						emit(m.Event.Delta.Text)
					}
				}
			case "assistant":
				for _, b := range m.Message.Content {
					if b.Type == "tool_use" && (allowedMCP == "" || !strings.HasPrefix(b.Name, allowedMCP)) {
						return ErrToolUse
					}
				}
			case "result":
				final.WriteString(m.Result)
				isErr = m.IsError
			}
			return nil
		}})
	if errors.Is(err, ErrToolUse) {
		return "", ErrToolUse
	}
	text := final.String()
	if text == "" {
		text = streamed.String()
	}
	if isErr {
		if needsSignIn(text) {
			return "", fmt.Errorf("%w: run `claude auth login`", ErrNeedsSignIn)
		}
		return "", errors.New(strings.TrimSpace(text))
	}
	if err != nil && text == "" {
		if needsSignIn(stderr) {
			return "", fmt.Errorf("%w: run `claude auth login`", ErrNeedsSignIn)
		}
		return "", fmt.Errorf("claude failed: %v %s", err, strings.TrimSpace(firstLine(stderr)))
	}
	return text, nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(strings.TrimSpace(s), '\n'); i >= 0 {
		return strings.TrimSpace(s)[:i]
	}
	return strings.TrimSpace(s)
}
