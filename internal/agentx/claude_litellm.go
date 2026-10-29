package agentx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"vvterm/internal/domain/assistant"
)

// gatewayConfig is where Claude Code sends its requests when it is pointed at a gateway such as a LiteLLM
// proxy (ANTHROPIC_BASE_URL), and the credential it uses there.
type gatewayConfig struct {
	BaseURL   string
	AuthToken string // ANTHROPIC_AUTH_TOKEN, sent as Authorization: Bearer
	APIKey    string // ANTHROPIC_API_KEY, sent as x-api-key
}

func (c *Claude) getenv(name string) string {
	if c.Getenv != nil {
		return c.Getenv(name)
	}
	return os.Getenv(name)
}

func (c *Claude) configDir() string {
	if c.ConfigDir != "" {
		return c.ConfigDir
	}
	if d := c.getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	u, _ := os.UserHomeDir()
	return filepath.Join(u, ".claude")
}

// gateway reads the same settings Claude Code reads: the process environment first, then the "env" block of
// settings.json. Only the three gateway values are taken from that file. ok is false when no base URL is set.
func (c *Claude) gateway() (g gatewayConfig, ok bool) {
	var fileEnv map[string]string
	if b, err := os.ReadFile(filepath.Join(c.configDir(), "settings.json")); err == nil {
		var s struct {
			Env map[string]any `json:"env"`
		}
		if json.Unmarshal(b, &s) == nil {
			fileEnv = map[string]string{}
			for k, v := range s.Env {
				if str, isStr := v.(string); isStr {
					fileEnv[k] = str
				}
			}
		}
	}
	get := func(name string) string {
		if v := strings.TrimSpace(c.getenv(name)); v != "" {
			return v
		}
		return strings.TrimSpace(fileEnv[name])
	}
	g = gatewayConfig{BaseURL: get("ANTHROPIC_BASE_URL"), AuthToken: get("ANTHROPIC_AUTH_TOKEN"), APIKey: get("ANTHROPIC_API_KEY")}
	return g, g.BaseURL != ""
}

// gatewayModels lists the models of a LiteLLM proxy with GET {base}/v1/models. LiteLLM answers in the OpenAI
// shape ({"data":[{"id":...}]}); the Anthropic shape (display_name) is read too, so a plain Anthropic-compatible
// gateway works as well.
func (c *Claude) gatewayModels(ctx context.Context, g gatewayConfig) ([]assistant.Model, error) {
	base := strings.TrimRight(g.BaseURL, "/")
	base = strings.TrimSuffix(base, "/v1")
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/models", nil)
	if err != nil {
		return nil, fmt.Errorf("gateway URL %q is not valid: %w", g.BaseURL, err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	switch {
	case g.AuthToken != "":
		req.Header.Set("Authorization", "Bearer "+g.AuthToken)
	case g.APIKey != "":
		req.Header.Set("x-api-key", g.APIKey)
		req.Header.Set("Authorization", "Bearer "+g.APIKey) // LiteLLM virtual keys are read from Authorization
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gateway %s: %w", base, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gateway %s/v1/models: %s %s", base, resp.Status, firstLine(string(body)))
	}
	var f struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
			OwnedBy     string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &f); err != nil {
		return nil, fmt.Errorf("gateway model list unreadable: %w", err)
	}
	seen := map[string]bool{}
	var out []assistant.Model
	for _, m := range f.Data {
		if m.ID == "" || seen[m.ID] || strings.Contains(m.ID, "*") { // skip wildcard routes such as anthropic/*
			continue
		}
		seen[m.ID] = true
		name := m.DisplayName
		if name == "" {
			name = m.ID
		}
		out = append(out, assistant.Model{ID: m.ID, Name: name, Description: "via " + base})
	}
	// Claude models first, then the rest; each group keeps the gateway's order.
	sort.SliceStable(out, func(i, j int) bool { return isClaudeModel(out[i].ID) && !isClaudeModel(out[j].ID) })
	if len(out) == 0 {
		return nil, errors.New("the gateway lists no models")
	}
	return out, nil
}

func isClaudeModel(id string) bool {
	id = strings.ToLower(id)
	return strings.Contains(id, "claude") || strings.Contains(id, "anthropic")
}
