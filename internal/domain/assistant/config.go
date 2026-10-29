package assistant

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// ToolMode says how a tool of an MCP server may be called.
type ToolMode string

const (
	ToolAllow ToolMode = "allow"
	ToolAsk   ToolMode = "ask"
	ToolOff   ToolMode = "off"
)

// MCP server types.
const (
	MCPStdio = "stdio"
	MCPHTTP  = "http"
)

// MCPServer is a user-added MCP server. Environment values and header values are secrets: they live in the
// vault and only their ids are kept here (EnvRefs, HeaderRefs map a name to a vault secret id).
type MCPServer struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Type       string            `json:"type"` // stdio | http
	Command    string            `json:"command,omitempty"`
	Args       []string          `json:"args,omitempty"`
	URL        string            `json:"url,omitempty"`
	EnvRefs    map[string]string `json:"env_refs,omitempty"`
	HeaderRefs map[string]string `json:"header_refs,omitempty"`
	Enabled    bool              `json:"enabled"`
	// Trusted lets a read-only tool run without asking. Off by default.
	Trusted bool `json:"trusted"`
	// HostIDs limits the server to these hosts (empty: every host). Providers likewise (empty: all).
	HostIDs   []string `json:"host_ids,omitempty"`
	Providers []string `json:"providers,omitempty"`
	// Tools holds the mode of every tool the user has reviewed. A tool that is not listed is new and stays off.
	Tools map[string]ToolMode `json:"tools,omitempty"`
}

var mcpName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9 _-]{0,39}$`)

// Validate checks a server definition before it is stored.
func (s MCPServer) Validate() error {
	if !mcpName.MatchString(s.Name) {
		return errors.New("name: 1-40 letters, digits, spaces, - or _, starting with a letter")
	}
	switch s.Type {
	case MCPStdio:
		if strings.TrimSpace(s.Command) == "" {
			return errors.New("command is required")
		}
		if strings.ContainsAny(s.Command, "\x00\r\n") {
			return errors.New("command must not contain control characters")
		}
	case MCPHTTP:
		if !strings.HasPrefix(s.URL, "https://") && !strings.HasPrefix(s.URL, "http://") {
			return errors.New("url must start with http:// or https://")
		}
	default:
		return fmt.Errorf("type must be %s or %s", MCPStdio, MCPHTTP)
	}
	for name := range s.EnvRefs {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(name) {
			return fmt.Errorf("invalid environment variable name %q", name)
		}
	}
	return nil
}

// Slug is the part of a tool name that identifies the server (letters, digits, underscore).
func (s MCPServer) Slug() string {
	b := []byte(strings.ToLower(s.Name))
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			b[i] = '_'
		}
	}
	return string(b)
}

// InScope reports whether the server may be offered for this host and provider.
func (s MCPServer) InScope(hostID, provider string) bool {
	if !s.Enabled {
		return false
	}
	if len(s.HostIDs) > 0 && !contains(s.HostIDs, hostID) {
		return false
	}
	return len(s.Providers) == 0 || contains(s.Providers, provider)
}

func contains(l []string, v string) bool {
	for _, x := range l {
		if x == v {
			return true
		}
	}
	return false
}

// ProviderConfig is what the user chose for one provider.
type ProviderConfig struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model,omitempty"` // default model; "" = the CLI decides
	// VerifiedVersion is the CLI version that passed the isolation self-test.
	VerifiedVersion string   `json:"verified_version,omitempty"`
	CustomModels    []string `json:"custom_models,omitempty"`
}

// CustomProvider is a command the user wired up as a provider.
type CustomProvider struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Command   string   `json:"command"`
	Args      []string `json:"args,omitempty"`
	PromptVia string   `json:"prompt_via,omitempty"`
}

// Config is the assistant's settings file. It never holds a secret.
type Config struct {
	Providers       map[string]ProviderConfig `json:"providers"`
	DefaultProvider string                    `json:"default_provider,omitempty"`
	Custom          []CustomProvider          `json:"custom,omitempty"`
	// Lines of terminal sent to the agent.
	Lines int `json:"lines"`
	// Patterns are extra redaction regular expressions (they only add to the built-in detectors).
	Patterns []string `json:"patterns,omitempty"`
	// AutoRun lets the assistant run commands from the read-only allow-list by itself (off by default).
	AutoRun bool        `json:"auto_run"`
	MCP     []MCPServer `json:"mcp,omitempty"`
}

// DefaultConfig is the first-run configuration: every provider off.
func DefaultConfig() Config {
	return Config{Providers: map[string]ProviderConfig{}, Lines: 200}
}

// Normalize clamps values and drops what cannot be valid.
func (c *Config) Normalize() {
	if c.Providers == nil {
		c.Providers = map[string]ProviderConfig{}
	}
	if c.Lines < 20 {
		c.Lines = 200
	}
	if c.Lines > 1000 {
		c.Lines = 1000
	}
}

// ParseConfig reads assistant.json content.
func ParseConfig(b []byte) (Config, error) {
	c := DefaultConfig()
	if len(strings.TrimSpace(string(b))) == 0 {
		return c, nil
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return DefaultConfig(), err
	}
	c.Normalize()
	return c, nil
}

// Tool is one tool an MCP server offers.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	// ReadOnly is the server's own claim (annotation readOnlyHint); it is advisory.
	ReadOnly bool `json:"readOnly"`
}

// ToolResult is what a tool call returns, as text.
type ToolResult struct {
	Text    string
	IsError bool
}

// ToolServer provides tools: a user's MCP server or the built-in terminal tools.
type ToolServer interface {
	Tools() ([]Tool, error)
	Call(name string, args json.RawMessage) (ToolResult, error)
	Close()
}

// GatewayHooks are where VVTerm enforces its rules on every tool call the agent makes.
type GatewayHooks struct {
	// Authorize may block a call (a non-nil error is told to the agent). It may wait for the user.
	Authorize func(server, tool string, args json.RawMessage) error
	// Clean redacts and limits a result before the agent sees it.
	Clean func(text string) string
	// Visible tells whether a tool is offered to the agent at all.
	Visible func(server string, t Tool) bool
	// Observe is told about each call (for the UI and the log).
	Observe func(server, tool, state, note string)
}
