package agentx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"vvterm/internal/domain/assistant"
)

// Codex drives the Codex CLI through `codex exec`.
type Codex struct {
	Bin string
	// Home overrides the Codex folder (tests); empty means $CODEX_HOME or ~/.codex.
	Home string
}

func (c *Codex) ID() string        { return "codex" }
func (c *Codex) Name() string      { return "Codex CLI" }
func (c *Codex) SupportsMCP() bool { return false } // not verified: see docs/AIAssistant.md 5.7

// SupportsImages: pictures are written into the empty working directory and passed with -i.
func (c *Codex) SupportsImages() bool { return true }

func (c *Codex) bin() string {
	if c.Bin != "" {
		return c.Bin
	}
	return findBinary("codex")
}

func (c *Codex) env() []string { return baseEnv("CODEX_HOME") }

func (c *Codex) home() string {
	if c.Home != "" {
		return c.Home
	}
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return h
	}
	u, _ := os.UserHomeDir()
	return filepath.Join(u, ".codex")
}

func (c *Codex) Detect(ctx context.Context) assistant.Status {
	bin := c.bin()
	if bin == "" {
		return assistant.Status{State: assistant.StateNotFound, Detail: "codex was not found", Hint: "Install the Codex CLI"}
	}
	vout, err := output(bin, 5*time.Second, c.env(), "--version")
	if err != nil {
		return assistant.Status{State: assistant.StateUnsupported, Detail: "codex --version failed"}
	}
	st := assistant.Status{Version: parseVersion(vout)}
	help, _ := output(bin, 5*time.Second, c.env(), "exec", "--help")
	for _, f := range []string{"--ignore-user-config", "--disable", "--sandbox", "--ephemeral", "--json"} {
		if !strings.Contains(help, f) {
			st.State, st.Detail = assistant.StateUnsupported, "this version lacks "+f+", which the isolation needs"
			return st
		}
	}
	// shell_tool is the tool that runs commands; apps is the built-in connector through which it can still search the web
	feats, _ := output(bin, 8*time.Second, c.env(), "features", "list")
	for _, f := range []string{"shell_tool", "apps"} {
		if !strings.Contains(feats, f) {
			st.State, st.Detail = assistant.StateUnsupported, "this version cannot turn its "+f+" feature off"
			return st
		}
	}
	if _, err := output(bin, 8*time.Second, c.env(), "login", "status"); err != nil {
		st.State, st.Detail, st.Hint = assistant.StateNeedsSignIn, "not signed in", "codex login"
		return st
	}
	st.State = assistant.StateReady
	return st
}

// Models reads the catalogue Codex fetched from the provider and cached. Only that file is read, never the
// credentials next to it.
func (c *Codex) Models(ctx context.Context) ([]assistant.Model, error) {
	b, err := os.ReadFile(filepath.Join(c.home(), "models_cache.json"))
	if err != nil {
		return nil, errors.New("Codex has not fetched its model list yet: run codex once")
	}
	var f struct {
		Models []struct {
			Slug        string `json:"slug"`
			DisplayName string `json:"display_name"`
			Description string `json:"description"`
			Visibility  string `json:"visibility"`
			Priority    int    `json:"priority"`
		} `json:"models"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("model list unreadable: %w", err)
	}
	sort.SliceStable(f.Models, func(i, j int) bool { return f.Models[i].Priority < f.Models[j].Priority })
	var out []assistant.Model
	for _, m := range f.Models {
		if m.Slug != "" && m.Visibility == "list" {
			name := m.DisplayName
			if name == "" {
				name = m.Slug
			}
			out = append(out, assistant.Model{ID: m.Slug, Name: name, Description: m.Description})
		}
	}
	if len(out) == 0 {
		return nil, errors.New("Codex lists no models")
	}
	return out, nil
}

func (c *Codex) Verify(ctx context.Context) error { return verifyIsolation(ctx, c.Ask) }

func (c *Codex) Ask(ctx context.Context, r assistant.Request, emit func(string)) (string, error) {
	bin := c.bin()
	if bin == "" {
		return "", errors.New("codex was not found")
	}
	dir, done, err := tempDir()
	if err != nil {
		return "", err
	}
	defer done()
	args := []string{"exec", "--disable", "shell_tool", "--disable", "apps", "-c", `web_search="disabled"`, "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
		"--skip-git-repo-check", "--ephemeral", "--json", "-C", dir}
	if r.Model != "" {
		args = append(args, "-m", r.Model)
	}
	if len(r.Images) == 0 {
		args = append(args, "-")
	}
	for i, im := range r.Images { // the prompt then comes from stdin: "-i" takes every value that follows it
		path := filepath.Join(dir, fmt.Sprintf("image-%d%s", i+1, im.Ext()))
		if err := os.WriteFile(path, im.Data(), 0o600); err != nil {
			return "", err
		}
		args = append(args, "-i", path)
	}
	var last string
	var failure string
	stderr, err := run(ctx, runOpts{bin: bin, args: args, stdin: userPrompt(r, true), dir: dir, env: c.env(),
		onLine: func(line []byte) error {
			var m struct {
				Type    string `json:"type"`
				Message string `json:"message"`
				Error   struct {
					Message string `json:"message"`
				} `json:"error"`
				Item struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"item"`
			}
			if json.Unmarshal(line, &m) != nil {
				return nil
			}
			switch m.Type {
			case "item.started", "item.updated", "item.completed":
				switch m.Item.Type {
				case "agent_message":
					if m.Type == "item.completed" {
						last = m.Item.Text
						if emit != nil {
							emit(m.Item.Text)
						}
					}
				case "reasoning", "":
				default: // command_execution, mcp_tool_call, file_change, web_search...: no tools are allowed
					return ErrToolUse
				}
			case "error":
				failure = m.Message
			case "turn.failed":
				failure = m.Error.Message
			}
			return nil
		}})
	if errors.Is(err, ErrToolUse) {
		return "", ErrToolUse
	}
	if last != "" {
		return last, nil
	}
	if failure != "" {
		if needsSignIn(failure) {
			return "", fmt.Errorf("%w: run `codex login`", ErrNeedsSignIn)
		}
		return "", errors.New(failure)
	}
	if err != nil {
		if needsSignIn(stderr) {
			return "", fmt.Errorf("%w: run `codex login`", ErrNeedsSignIn)
		}
		return "", fmt.Errorf("codex failed: %v %s", err, firstLine(stderr))
	}
	return "", errors.New("codex returned no answer")
}
