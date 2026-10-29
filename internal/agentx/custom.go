package agentx

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"

	"vvterm/internal/domain/assistant"
)

// CustomConfig describes an AI command-line tool VVTerm has no adapter for.
type CustomConfig struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Command string   `json:"command"` // program name or path
	Args    []string `json:"args"`    // "{prompt}" is replaced by the prompt when PromptVia is "arg"
	// PromptVia is "stdin" (default) or "arg".
	PromptVia string `json:"prompt_via"`
}

// Custom runs a user-configured command. Its tools cannot be switched off from here, so it is enabled only
// after the isolation self-test passes, like every provider.
type Custom struct{ Cfg CustomConfig }

func (c *Custom) ID() string                                            { return c.Cfg.ID }
func (c *Custom) Name() string                                          { return c.Cfg.Name }
func (c *Custom) SupportsMCP() bool                                     { return false }
func (c *Custom) Models(ctx context.Context) ([]assistant.Model, error) { return nil, nil }
func (c *Custom) Verify(ctx context.Context) error                      { return verifyIsolation(ctx, c.Ask) }

func (c *Custom) bin() string {
	if strings.ContainsAny(c.Cfg.Command, `/\`) {
		if p, err := exec.LookPath(c.Cfg.Command); err == nil {
			return p
		}
		return ""
	}
	return findBinary(c.Cfg.Command)
}

func (c *Custom) Detect(ctx context.Context) assistant.Status {
	bin := c.bin()
	if bin == "" {
		return assistant.Status{State: assistant.StateNotFound, Detail: c.Cfg.Command + " was not found"}
	}
	st := assistant.Status{State: assistant.StateReady, Detail: "custom command: tools cannot be checked until enabled"}
	if v, err := output(bin, 5*time.Second, baseEnv(), "--version"); err == nil {
		st.Version = parseVersion(v)
	}
	return st
}

func (c *Custom) Ask(ctx context.Context, r assistant.Request, emit func(string)) (string, error) {
	bin := c.bin()
	if bin == "" {
		return "", errors.New(c.Cfg.Command + " was not found")
	}
	dir, done, err := tempDir()
	if err != nil {
		return "", err
	}
	defer done()
	prompt := userPrompt(r, true)
	args := make([]string, 0, len(c.Cfg.Args))
	for _, a := range c.Cfg.Args {
		args = append(args, strings.ReplaceAll(a, "{prompt}", prompt))
	}
	opts := runOpts{bin: bin, args: args, dir: dir, env: baseEnv()}
	if c.Cfg.PromptVia != "arg" {
		opts.stdin = prompt
	}
	var out strings.Builder
	opts.onLine = func(line []byte) error {
		out.Write(line)
		out.WriteByte('\n')
		if emit != nil {
			emit(string(line) + "\n")
		}
		return nil
	}
	stderr, err := run(ctx, opts)
	if err != nil && out.Len() == 0 {
		return "", errors.New(firstLine(stderr + " " + err.Error()))
	}
	return strings.TrimSpace(out.String()), nil
}
