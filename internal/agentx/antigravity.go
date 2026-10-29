package agentx

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"vvterm/internal/domain/assistant"
)

// ErrToolDenied: see assistant.ErrToolDenied.
var ErrToolDenied = assistant.ErrToolDenied

// Antigravity drives the Antigravity CLI (`agy`) in print mode. It is a different tool from the Gemini CLI: it has its
// own sign-in and models. Its tools cannot be switched off with a flag, and it applies the user's own allow-rules, so
// every call is started with session-only settings that deny commands and MCP tools (a deny beats an allow-rule),
// every other tool needs a permission that print mode cannot ask for and is refused, and a tool that is reported as
// done is a violation. The isolation self-test decides whether the provider can be switched on at all.
type Antigravity struct {
	Bin string
}

func (a *Antigravity) ID() string        { return "antigravity" }
func (a *Antigravity) Name() string      { return "Antigravity CLI" }
func (a *Antigravity) SupportsMCP() bool { return false }

func (a *Antigravity) bin() string {
	if a.Bin != "" {
		return a.Bin
	}
	return findBinary("agy")
}

func (a *Antigravity) env() []string { return baseEnv() }

// agyDeny is applied to every call. It only adds denials for this session and is never saved.
const agyDeny = `{"permissions":{"allow":[],"deny":["command(*)","mcp(*)","read_file(*)","write_file(*)","edit_file(*)","execute_url(*)"]}}`

func (a *Antigravity) Detect(ctx context.Context) assistant.Status {
	bin := a.bin()
	if bin == "" {
		return assistant.Status{State: assistant.StateNotFound, Detail: "agy was not found", Hint: "Install the Antigravity CLI"}
	}
	vout, err := output(bin, 5*time.Second, a.env(), "--version")
	if err != nil {
		return assistant.Status{State: assistant.StateUnsupported, Detail: "agy --version failed"}
	}
	st := assistant.Status{Version: parseVersion(vout)}
	help, _ := output(bin, 5*time.Second, a.env(), "--help")
	for _, f := range []string{"--print", "--output-format", "--settings", "--model"} {
		if !strings.Contains(help, f) {
			st.State, st.Detail = assistant.StateUnsupported, "this version lacks "+f+", which the isolation needs"
			return st
		}
	}
	// the model list needs the sign-in, so it tells whether the user is signed in
	if ms, err := a.Models(ctx); err != nil || len(ms) == 0 {
		st.State, st.Detail, st.Hint = assistant.StateNeedsSignIn, "not signed in", "agy"
		return st
	}
	st.State = assistant.StateReady
	return st
}

// Models reads `agy models`: one "id<TAB>name" per line, after a progress line.
func (a *Antigravity) Models(ctx context.Context) ([]assistant.Model, error) {
	bin := a.bin()
	if bin == "" {
		return nil, errors.New("agy was not found")
	}
	out, err := output(bin, 30*time.Second, a.env(), "models")
	if err != nil {
		return nil, errors.New("Antigravity could not list its models: " + firstLine(out))
	}
	var ms []assistant.Model
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		id, name, ok := strings.Cut(sc.Text(), "\t")
		id = strings.TrimSpace(id)
		if !ok || id == "" || strings.ContainsAny(id, " \t") {
			continue
		}
		ms = append(ms, assistant.Model{ID: id, Name: strings.TrimSpace(name)})
	}
	if len(ms) == 0 {
		return nil, errors.New("Antigravity lists no models: sign in with agy first")
	}
	return ms, nil
}

func (a *Antigravity) Verify(ctx context.Context) error { return verifyIsolation(ctx, a.Ask) }

func (a *Antigravity) Ask(ctx context.Context, r assistant.Request, emit func(string)) (string, error) {
	bin := a.bin()
	if bin == "" {
		return "", errors.New("agy was not found")
	}
	dir, done, err := tempDir()
	if err != nil {
		return "", err
	}
	defer done()
	args := []string{"--settings", agyDeny, "--output-format", "stream-json", "--disable-slash-commands"}
	if r.Model != "" {
		args = append(args, "--model", r.Model)
	}
	args = append(args, "--print", userPrompt(r, true))
	var said strings.Builder
	var final string
	var attempts int
	var denied string
	stderr, err := run(ctx, runOpts{bin: bin, args: args, dir: dir, env: a.env(),
		onLine: func(line []byte) error {
			var m struct {
				Event  string `json:"event"`
				Result struct {
					Status   string `json:"status"`
					Response string `json:"response"`
				} `json:"result"`
				Step struct {
					Type  string `json:"step_type"`
					State string `json:"state"`
					Text  string `json:"text_delta"`
				} `json:"step_update"`
			}
			if json.Unmarshal(line, &m) != nil {
				// not an event: the CLI explains a refusal in plain text
				if strings.Contains(string(line), "auto-denied") || strings.Contains(string(line), "permission") {
					denied = string(line)
				}
				return nil
			}
			switch {
			case m.Event == "step_update" && m.Step.Type == "tool":
				attempts++
				if m.Step.State == "DONE" {
					return ErrToolUse // the tool ran
				}
			case m.Event == "step_update" && m.Step.Type == "agent_response" && m.Step.Text != "":
				said.WriteString(m.Step.Text)
				if emit != nil {
					emit(m.Step.Text)
				}
			case m.Event == "result":
				final = m.Result.Response
			}
			return nil
		}})
	if errors.Is(err, ErrToolUse) {
		return "", ErrToolUse
	}
	text := strings.TrimSpace(final)
	if text == "" {
		text = strings.TrimSpace(said.String())
	}
	if text == "" && attempts > 0 {
		return "", ErrToolDenied
	}
	if text != "" {
		return text, nil
	}
	if needsSignIn(stderr + denied) {
		return "", fmt.Errorf("%w: run `agy`", ErrNeedsSignIn)
	}
	if err != nil {
		return "", fmt.Errorf("agy failed: %v %s", err, firstLine(stderr))
	}
	return "", errors.New("agy returned no answer")
}
