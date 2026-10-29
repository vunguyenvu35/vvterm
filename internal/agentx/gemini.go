package agentx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"vvterm/internal/domain/assistant"
)

// Gemini drives the Gemini CLI in headless mode. It cannot list its models, so only the default and a custom id
// are offered.
type Gemini struct {
	Bin string
	// Home overrides the folder with the sign-in files (tests); empty means ~/.gemini.
	Home string
}

func (g *Gemini) ID() string        { return "gemini" }
func (g *Gemini) Name() string      { return "Gemini CLI" }
func (g *Gemini) SupportsMCP() bool { return false }

func (g *Gemini) bin() string {
	if g.Bin != "" {
		return g.Bin
	}
	return findBinary("gemini")
}

func (g *Gemini) env() []string { return baseEnv("GEMINI_CLI_HOME") }

func (g *Gemini) home() string {
	if g.Home != "" {
		return g.Home
	}
	u, _ := os.UserHomeDir()
	return filepath.Join(u, ".gemini")
}

func (g *Gemini) Detect(ctx context.Context) assistant.Status {
	bin := g.bin()
	if bin == "" {
		return assistant.Status{State: assistant.StateNotFound, Detail: "gemini was not found", Hint: "Install the Gemini CLI"}
	}
	vout, err := output(bin, 5*time.Second, g.env(), "--version")
	if err != nil {
		return assistant.Status{State: assistant.StateUnsupported, Detail: "gemini --version failed"}
	}
	st := assistant.Status{Version: parseVersion(vout)}
	help, _ := output(bin, 5*time.Second, g.env(), "--help")
	for _, f := range []string{"--policy", "--approval-mode", "--output-format", "--extensions"} {
		if !strings.Contains(help, f) {
			st.State, st.Detail = assistant.StateUnsupported, "this version lacks "+f+", which the isolation needs"
			return st
		}
	}
	// Which sign-in the CLI is set to is read from its settings (not a secret); the sign-in file itself is only
	// checked for existence, never read. Only "Login with Google" works: the other methods need an API key or
	// a gateway from the environment, which VVTerm does not pass on.
	kind := g.authType()
	switch {
	case kind == "":
		st.State, st.Detail, st.Hint = assistant.StateNeedsSignIn, "not signed in", "gemini"
		return st
	case kind != "oauth-personal":
		st.State, st.Detail, st.Hint = assistant.StateNeedsSignIn, "Gemini CLI is set to sign in with "+kind+", which VVTerm cannot use", "gemini (choose Login with Google)"
		return st
	}
	if _, err := os.Stat(filepath.Join(g.home(), "oauth_creds.json")); err != nil {
		st.State, st.Detail, st.Hint = assistant.StateNeedsSignIn, "not signed in", "gemini"
		return st
	}
	st.State = assistant.StateReady
	return st
}

// authType is the sign-in method selected in the CLI's settings ("" when none).
func (g *Gemini) authType() string {
	b, err := os.ReadFile(filepath.Join(g.home(), "settings.json"))
	if err != nil {
		return ""
	}
	var f struct {
		Security struct {
			Auth struct {
				SelectedType string `json:"selectedType"`
			} `json:"auth"`
		} `json:"security"`
		SelectedAuthType string `json:"selectedAuthType"`
	}
	if json.Unmarshal(b, &f) != nil {
		return ""
	}
	if f.Security.Auth.SelectedType != "" {
		return f.Security.Auth.SelectedType
	}
	return f.SelectedAuthType
}

// Models: Gemini CLI has no way to list models, so there is nothing to load.
func (g *Gemini) Models(ctx context.Context) ([]assistant.Model, error) { return nil, nil }

func (g *Gemini) Verify(ctx context.Context) error { return verifyIsolation(ctx, g.Ask) }

const geminiDenyAll = `[[rule]]
toolName = "*"
decision = "deny"
priority = 999
`

func (g *Gemini) Ask(ctx context.Context, r assistant.Request, emit func(string)) (string, error) {
	bin := g.bin()
	if bin == "" {
		return "", errors.New("gemini was not found")
	}
	dir, done, err := tempDir()
	if err != nil {
		return "", err
	}
	defer done()
	policy := filepath.Join(dir, "deny-all.toml")
	if err := os.WriteFile(policy, []byte(geminiDenyAll), 0o600); err != nil {
		return "", err
	}
	args := []string{"--policy", policy, "--approval-mode", "plan", "-e", "none", "--skip-trust", "-o", "json"}
	if r.Model != "" {
		args = append(args, "-m", r.Model)
	}
	args = append(args, "-p", "Answer the request given on stdin.")
	var out bytes.Buffer
	stderr, err := run(ctx, runOpts{bin: bin, args: args, stdin: userPrompt(r, true), dir: dir, env: g.env(),
		onLine: func(line []byte) error { out.Write(line); out.WriteByte('\n'); return nil }})
	var res struct {
		Response string `json:"response"`
		Stats    struct {
			Tools struct {
				TotalCalls int `json:"totalCalls"`
			} `json:"tools"`
		} `json:"stats"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if jerr := json.Unmarshal(out.Bytes(), &res); jerr == nil {
		if res.Stats.Tools.TotalCalls > 0 {
			return "", ErrToolUse
		}
		if res.Error != nil && res.Error.Message != "" {
			if needsSignIn(res.Error.Message) {
				return "", fmt.Errorf("%w: run `gemini`", ErrNeedsSignIn)
			}
			return "", errors.New(res.Error.Message)
		}
		if res.Response != "" {
			if emit != nil {
				emit(res.Response)
			}
			return res.Response, nil
		}
	}
	if needsSignIn(stderr + out.String()) {
		return "", fmt.Errorf("%w: run `gemini`", ErrNeedsSignIn)
	}
	if err != nil {
		return "", fmt.Errorf("gemini failed: %v %s", err, firstLine(stderr))
	}
	return "", errors.New("gemini returned no answer")
}
