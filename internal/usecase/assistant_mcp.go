package usecase

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/domain/assistant"
	"vvterm/internal/domain/secretpolicy"
)

// ---- what the agent can reach through the gateway ----

// lazyServer starts a user's MCP server only when the agent first looks at it.
type lazyServer struct {
	connect func() (assistant.ToolServer, error)
	once    sync.Once
	srv     assistant.ToolServer
	err     error
}

func (l *lazyServer) open() (assistant.ToolServer, error) {
	l.once.Do(func() { l.srv, l.err = l.connect() })
	return l.srv, l.err
}

func (l *lazyServer) Tools() ([]assistant.Tool, error) {
	s, err := l.open()
	if err != nil {
		return nil, err
	}
	return s.Tools()
}

func (l *lazyServer) Call(name string, args json.RawMessage) (assistant.ToolResult, error) {
	s, err := l.open()
	if err != nil {
		return assistant.ToolResult{}, err
	}
	return s.Call(name, args)
}

func (l *lazyServer) Close() {
	if l.srv != nil {
		l.srv.Close()
	}
}

// terminalTools are the built-in tools: read the screen, propose a command, and (only when the user turned
// auto-run on) run one read-only command.
type terminalTools struct {
	a       *AssistantService
	run     *assistRun
	autoRun bool
}

func (t *terminalTools) Tools() ([]assistant.Tool, error) {
	ro := func(n, d, schema string) assistant.Tool {
		return assistant.Tool{Name: n, Description: d, InputSchema: json.RawMessage(schema), ReadOnly: true}
	}
	tools := []assistant.Tool{
		ro("terminal_read", "Read the latest text of the user's terminal. Secrets appear as *******.", `{"type":"object","properties":{"lines":{"type":"integer","description":"how many last lines (max 300)"}}}`),
		{Name: "terminal_propose_command", Description: "Show the user a command to approve. It is not run.", InputSchema: json.RawMessage(`{"type":"object","properties":{"cmd":{"type":"string"},"why":{"type":"string"}},"required":["cmd"]}`)},
	}
	if t.autoRun {
		tools = append(tools, assistant.Tool{Name: "terminal_run", Description: "Run one read-only command (ls, df, uptime, journalctl -n N, systemctl status X, ...) and read its output. Other commands are refused.", InputSchema: json.RawMessage(`{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}`)})
	}
	return tools, nil
}

func (t *terminalTools) Call(name string, args json.RawMessage) (assistant.ToolResult, error) {
	var in struct {
		Lines int    `json:"lines"`
		Cmd   string `json:"cmd"`
		Why   string `json:"why"`
	}
	_ = json.Unmarshal(args, &in)
	switch name {
	case "terminal_read":
		if in.Lines <= 0 || in.Lines > 300 {
			in.Lines = 100
		}
		text, _, _, err := t.a.screenText(t.run.sid, in.Lines, "")
		return assistant.ToolResult{Text: text}, err
	case "terminal_propose_command":
		cmd := strings.TrimSpace(in.Cmd)
		if cmd == "" || hasControl(cmd) {
			return assistant.ToolResult{Text: "the command must be one non-empty line", IsError: true}, nil
		}
		t.run.mu.Lock()
		t.run.proposed = append(t.run.proposed, proposal{cmd, in.Why})
		t.run.mu.Unlock()
		return assistant.ToolResult{Text: "The command was shown to the user, who decides whether to run it."}, nil
	case "terminal_run":
		out, err := t.a.runAndRead(t.run.sid, strings.TrimSpace(in.Cmd))
		return assistant.ToolResult{Text: out}, err
	}
	return assistant.ToolResult{Text: "unknown tool", IsError: true}, nil
}

func (t *terminalTools) Close() {}

// resolveSecrets decrypts the environment and header values of a server for one connection.
func (a *AssistantService) resolveSecrets(s assistant.MCPServer) (env, headers map[string]string, err error) {
	get := func(refs map[string]string) (map[string]string, error) {
		out := map[string]string{}
		for name, id := range refs {
			b, err := a.c.Vault.GetSecret(id)
			if err != nil {
				return nil, err
			}
			out[name] = string(b)
		}
		return out, nil
	}
	if env, err = get(s.EnvRefs); err != nil {
		return nil, nil, err
	}
	headers, err = get(s.HeaderRefs)
	return env, headers, err
}

func (a *AssistantService) connectMCP(s assistant.MCPServer) (assistant.ToolServer, error) {
	if a.c.MCP == nil {
		return nil, errors.New("MCP servers are not available in this build")
	}
	env, headers, err := a.resolveSecrets(s)
	if err != nil {
		return nil, err
	}
	return a.c.MCP.Connect(s, env, headers)
}

// gatewayParts builds what the gateway serves for one question and the rules it enforces.
func (a *AssistantService) gatewayParts(run *assistRun, g secretpolicy.Guard, provider string, info SessionState) (map[string]assistant.ToolServer, assistant.GatewayHooks) {
	cfg := a.config()
	autoRun := cfg.AutoRun && !info.Production
	servers := map[string]assistant.ToolServer{"": &terminalTools{a: a, run: run, autoRun: autoRun}}
	byslug := map[string]assistant.MCPServer{}
	hostID := strings.TrimPrefix(info.HostID, telnetPrefix)
	for _, s := range cfg.MCP {
		if s.InScope(hostID, provider) {
			s := s
			byslug[s.Slug()] = s
			servers[s.Slug()] = &lazyServer{connect: func() (assistant.ToolServer, error) { return a.connectMCP(s) }}
		}
	}
	hooks := assistant.GatewayHooks{
		Visible: func(server string, t assistant.Tool) bool {
			if server == "" {
				return true
			}
			s, ok := byslug[server]
			if !ok {
				return false
			}
			run.mu.Lock()
			run.toolRO[server+"/"+t.Name] = t.ReadOnly
			run.mu.Unlock()
			m := s.Tools[t.Name]
			return m == assistant.ToolAllow || m == assistant.ToolAsk // new tools (not listed) stay hidden until reviewed
		},
		Authorize: func(server, tool string, args json.RawMessage) error {
			return a.authorizeCall(run, g, byslug, server, tool, args)
		},
		Clean: func(text string) string {
			out, _ := g.Clean(text)
			if len(out) > maxResultBytes {
				out = out[:maxResultBytes] + "\n[truncated]"
			}
			return out
		},
		Observe: func(server, tool, state, note string) {
			label := tool
			if server != "" {
				label = byslug[server].Name + " · " + tool
			}
			note, _ = g.Clean(note)
			a.emit("assistant:step:"+run.id, map[string]any{"server": server, "tool": label, "state": state, "note": note})
			if state == "calling" || state == "blocked" {
				a.c.record(domain.ActAssistant, run.hostID, "", fmt.Sprintf("Tool %s: %s", label, state), state == "calling")
			}
		},
	}
	return servers, hooks
}

func (a *AssistantService) authorizeCall(run *assistRun, g secretpolicy.Guard, byslug map[string]assistant.MCPServer, server, tool string, args json.RawMessage) error {
	if len(args) > 16<<10 {
		return errors.New("arguments are too large")
	}
	if server == "" {
		switch tool {
		case "terminal_read", "terminal_propose_command":
			return nil
		case "terminal_run":
			var in struct {
				Cmd string `json:"cmd"`
			}
			_ = json.Unmarshal(args, &in)
			info, err := a.SessionInfo(run.sid)
			switch {
			case err != nil:
				return err
			case !a.config().AutoRun:
				return errors.New("running commands by itself is turned off")
			case info.Production || !info.Connected || info.Policy == string(assistant.PolicyOff):
				return errors.New("commands cannot run by themselves on this terminal")
			case !assistant.ReadOnlyAllowed(in.Cmd) || g.Contains(in.Cmd):
				return errors.New("only read-only commands from the allow-list run by themselves: use terminal_propose_command")
			}
			run.mu.Lock()
			run.calls++
			n := run.calls
			run.mu.Unlock()
			if n > 5 {
				return errors.New("too many commands in one request")
			}
			return nil
		}
		return errors.New("unknown tool")
	}
	s, ok := byslug[server]
	if !ok {
		return errors.New("unknown server")
	}
	mode := s.Tools[tool]
	if mode == "" || mode == assistant.ToolOff {
		return errors.New("this tool is turned off")
	}
	// a secret in the arguments blocks the call: masking it would silently change what the call means
	if g.Contains(string(args)) {
		return errors.New("arguments contain sensitive data")
	}
	run.mu.Lock()
	ro := run.toolRO[server+"/"+tool]
	run.mu.Unlock()
	if mode == assistant.ToolAllow && !ro && !s.Trusted {
		mode = assistant.ToolAsk // a server that is not trusted never runs a side-effecting tool unasked
	}
	if mode == assistant.ToolAsk {
		return a.askUser(run, g, s.Name, tool, args)
	}
	return nil
}

func (a *AssistantService) askUser(run *assistRun, g secretpolicy.Guard, server, tool string, args json.RawMessage) error {
	run.mu.Lock()
	callID := fmt.Sprintf("c%d", len(run.confirms)+1)
	ch := make(chan bool, 1)
	run.confirms[callID] = ch
	run.mu.Unlock()
	shown, _ := g.Clean(string(args))
	a.emit("assistant:confirm:"+run.id, map[string]any{"call": callID, "server": server, "tool": tool, "args": shown})
	select {
	case ok := <-ch:
		if !ok {
			return errors.New("the user declined this call")
		}
		return nil
	case <-time.After(2 * time.Minute):
		return errors.New("the user did not answer")
	case <-run.ctx.Done():
		return errors.New("cancelled")
	}
}

// ---- managing MCP servers (Settings) ----

type McpServerView struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Type      string   `json:"type"`
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	URL       string   `json:"url"`
	Env       []string `json:"env"`     // names only: values are write-only
	Headers   []string `json:"headers"` // names only
	Enabled   bool     `json:"enabled"`
	Trusted   bool     `json:"trusted"`
	HostIDs   []string `json:"host_ids"`
	Providers []string `json:"providers"`
	Status    string   `json:"status"`
	Reviewed  int      `json:"reviewed"`
}

type McpServerInput struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	URL       string            `json:"url"`
	Env       map[string]string `json:"env"`     // a non-empty value is stored in the vault
	Headers   map[string]string `json:"headers"` // likewise
	RemoveEnv []string          `json:"remove_env"`
	RemoveHdr []string          `json:"remove_headers"`
	Enabled   bool              `json:"enabled"`
	Trusted   bool              `json:"trusted"`
	HostIDs   []string          `json:"host_ids"`
	Providers []string          `json:"providers"`
}

type McpToolView struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	ReadOnly    bool   `json:"read_only"`
	Mode        string `json:"mode"` // the stored mode, or the suggested one for a new tool
	New         bool   `json:"new"`  // not reviewed yet: stays off until a mode is chosen
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (a *AssistantService) mcpView(s assistant.MCPServer) McpServerView {
	a.mu.Lock()
	st := a.mcpState[s.ID]
	a.mu.Unlock()
	return McpServerView{ID: s.ID, Name: s.Name, Type: s.Type, Command: s.Command, Args: orEmpty(s.Args), URL: s.URL,
		Env: sortedKeys(s.EnvRefs), Headers: sortedKeys(s.HeaderRefs), Enabled: s.Enabled, Trusted: s.Trusted,
		HostIDs: orEmpty(s.HostIDs), Providers: orEmpty(s.Providers), Status: st, Reviewed: len(s.Tools)}
}

func (a *AssistantService) McpServers() []McpServerView {
	out := []McpServerView{}
	for _, s := range a.config().MCP {
		out = append(out, a.mcpView(s))
	}
	return out
}

func (a *AssistantService) findMCP(id string) (assistant.MCPServer, bool) {
	for _, s := range a.config().MCP {
		if s.ID == id {
			return s, true
		}
	}
	return assistant.MCPServer{}, false
}

// storeSecrets writes the given values into the vault and returns the updated name → secret id map.
func (a *AssistantService) storeSecrets(refs map[string]string, values map[string]string, remove []string) (map[string]string, error) {
	out := map[string]string{}
	for k, v := range refs {
		out[k] = v
	}
	for _, name := range remove {
		if id, ok := out[name]; ok {
			_ = a.c.Vault.DeleteSecret(id)
			delete(out, name)
		}
	}
	for name, val := range values {
		if val == "" {
			continue
		}
		if id, ok := out[name]; ok {
			if err := a.c.Vault.PutSecret(id, domain.SecretPassword, []byte(val)); err != nil {
				return nil, err
			}
			continue
		}
		id, err := a.c.Vault.AddSecret(domain.SecretPassword, []byte(val))
		if err != nil {
			return nil, err
		}
		out[name] = id
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// SaveMcpServer adds or changes a server. Environment and header values go to the vault and are never read
// back; an empty value keeps the stored one. A new server is off and untrusted until the user says otherwise.
func (a *AssistantService) SaveMcpServer(in McpServerInput) (McpServerView, error) {
	needsVault := len(in.RemoveEnv)+len(in.RemoveHdr) > 0
	for _, v := range in.Env {
		needsVault = needsVault || v != ""
	}
	for _, v := range in.Headers {
		needsVault = needsVault || v != ""
	}
	if needsVault && !a.c.Vault.Status().Unlocked {
		return McpServerView{}, errNotUnlocked
	}
	var saved assistant.MCPServer
	err := a.update(func(c *assistant.Config) error {
		s := assistant.MCPServer{ID: in.ID}
		idx := -1
		for i, x := range c.MCP {
			if x.ID == in.ID && in.ID != "" {
				s, idx = x, i
			}
		}
		if in.ID != "" && idx < 0 {
			return errors.New("unknown MCP server")
		}
		if idx < 0 {
			s.ID = domain.NewID()
		}
		s.Name, s.Type, s.Command, s.Args, s.URL = strings.TrimSpace(in.Name), in.Type, strings.TrimSpace(in.Command), in.Args, strings.TrimSpace(in.URL)
		s.Enabled, s.Trusted, s.HostIDs, s.Providers = in.Enabled, in.Trusted, in.HostIDs, in.Providers
		for _, x := range c.MCP {
			if x.ID != s.ID && x.Slug() == s.Slug() {
				return errors.New("another server already has this name")
			}
		}
		var err error
		if s.EnvRefs, err = a.storeSecrets(s.EnvRefs, in.Env, in.RemoveEnv); err != nil {
			return err
		}
		if s.HeaderRefs, err = a.storeSecrets(s.HeaderRefs, in.Headers, in.RemoveHdr); err != nil {
			return err
		}
		if err := s.Validate(); err != nil {
			return err
		}
		if idx < 0 {
			c.MCP = append(c.MCP, s)
		} else {
			c.MCP[idx] = s
		}
		saved = s
		return nil
	})
	if err != nil {
		return McpServerView{}, err
	}
	return a.mcpView(saved), nil
}

// DeleteMcpServer removes a server and its secrets.
func (a *AssistantService) DeleteMcpServer(id string) error {
	s, ok := a.findMCP(id)
	if !ok {
		return errors.New("unknown MCP server")
	}
	err := a.update(func(c *assistant.Config) error {
		var keep []assistant.MCPServer
		for _, x := range c.MCP {
			if x.ID != id {
				keep = append(keep, x)
			}
		}
		c.MCP = keep
		return nil
	})
	if err == nil && a.c.Vault.Status().Unlocked {
		for _, sid := range s.EnvRefs {
			_ = a.c.Vault.DeleteSecret(sid)
		}
		for _, sid := range s.HeaderRefs {
			_ = a.c.Vault.DeleteSecret(sid)
		}
	}
	return err
}

func suggestedMode(t assistant.Tool) assistant.ToolMode {
	if t.ReadOnly {
		return assistant.ToolAllow
	}
	return assistant.ToolAsk
}

// TestMcpServer starts the server, lists its tools and stops it. Nothing is sent to an AI provider.
func (a *AssistantService) TestMcpServer(id string) ([]McpToolView, error) {
	s, ok := a.findMCP(id)
	if !ok {
		return nil, errors.New("unknown MCP server")
	}
	srv, err := a.connectMCP(s)
	if err == nil {
		defer srv.Close()
	}
	var tools []assistant.Tool
	if err == nil {
		tools, err = srv.Tools()
	}
	a.mu.Lock()
	if err != nil {
		a.mcpState[id] = "Unavailable: " + err.Error()
	} else {
		a.mcpState[id] = "Connected"
	}
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	out := []McpToolView{}
	for _, t := range tools {
		v := McpToolView{Name: t.Name, Description: t.Description, ReadOnly: t.ReadOnly}
		if m, ok := s.Tools[t.Name]; ok {
			v.Mode = string(m)
		} else {
			v.Mode, v.New = string(suggestedMode(t)), true
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// SetMcpTool stores the mode of one tool, which also marks it as reviewed.
func (a *AssistantService) SetMcpTool(serverID, tool, mode string) error {
	m := assistant.ToolMode(mode)
	if m != assistant.ToolAllow && m != assistant.ToolAsk && m != assistant.ToolOff {
		return errors.New("mode must be allow, ask or off")
	}
	return a.update(func(c *assistant.Config) error {
		for i := range c.MCP {
			if c.MCP[i].ID == serverID {
				if c.MCP[i].Tools == nil {
					c.MCP[i].Tools = map[string]assistant.ToolMode{}
				}
				c.MCP[i].Tools[tool] = m
				return nil
			}
		}
		return errors.New("unknown MCP server")
	})
}

// ApproveNewTools reviews every new tool of a server with the suggested mode: allow for a read-only tool,
// ask for the others.
func (a *AssistantService) ApproveNewTools(serverID string) error {
	tools, err := a.TestMcpServer(serverID)
	if err != nil {
		return err
	}
	return a.update(func(c *assistant.Config) error {
		for i := range c.MCP {
			if c.MCP[i].ID != serverID {
				continue
			}
			if c.MCP[i].Tools == nil {
				c.MCP[i].Tools = map[string]assistant.ToolMode{}
			}
			for _, t := range tools {
				if t.New {
					c.MCP[i].Tools[t.Name] = assistant.ToolMode(t.Mode)
				}
			}
		}
		return nil
	})
}

// ---- importing from the CLIs' own configuration ----

type McpImportItem struct {
	Ref     string   `json:"ref"`
	Source  string   `json:"source"`
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	URL     string   `json:"url"`
	Env     []string `json:"env"`     // names only
	Headers []string `json:"headers"` // names only
}

type importedServer struct {
	item    McpImportItem
	env     map[string]string
	headers map[string]string
}

type cliMCP struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	URL     string            `json:"url"`
	HTTPURL string            `json:"httpUrl"`
	Headers map[string]string `json:"headers"`
}

// readImportable reads the CLIs' MCP lists. It is called only when the user opens the import dialog or
// presses Import, never in the background.
func readImportable() []importedServer {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var out []importedServer
	collect := func(source string, servers map[string]cliMCP) {
		for name, s := range servers {
			is := importedServer{item: McpImportItem{Ref: source + ":" + name, Source: source, Name: name, Command: s.Command, Args: orEmpty(s.Args)}, env: s.Env, headers: s.Headers}
			url := s.URL
			if s.HTTPURL != "" {
				url = s.HTTPURL
			}
			switch {
			case s.Command != "":
				is.item.Type = assistant.MCPStdio
			case url != "" && s.Type != "sse":
				is.item.Type, is.item.URL = assistant.MCPHTTP, url
			default:
				continue // an SSE-only server is not supported
			}
			is.item.Env, is.item.Headers = sortedKeys(s.Env), sortedKeys(s.Headers)
			out = append(out, is)
		}
	}
	if b, err := os.ReadFile(filepath.Join(home, ".claude.json")); err == nil {
		var f struct {
			MCP      map[string]cliMCP `json:"mcpServers"`
			Projects map[string]struct {
				MCP map[string]cliMCP `json:"mcpServers"`
			} `json:"projects"`
		}
		if json.Unmarshal(b, &f) == nil {
			collect("claude", f.MCP)
		}
	}
	if b, err := os.ReadFile(filepath.Join(home, ".gemini", "settings.json")); err == nil {
		var f struct {
			MCP map[string]cliMCP `json:"mcpServers"`
		}
		if json.Unmarshal(b, &f) == nil {
			collect("gemini", f.MCP)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].item.Ref < out[j].item.Ref })
	return out
}

func (a *AssistantService) ImportableMcpServers() ([]McpImportItem, error) {
	out := []McpImportItem{}
	for _, s := range readImportable() {
		out = append(out, s.item)
	}
	return out, nil
}

// ImportMcpServer copies one server; its secret values go to the vault. It starts off and untrusted.
func (a *AssistantService) ImportMcpServer(ref string) (McpServerView, error) {
	for _, s := range readImportable() {
		if s.item.Ref != ref {
			continue
		}
		name := s.item.Name
		for n := 2; ; n++ {
			clash := false
			for _, x := range a.config().MCP {
				clash = clash || x.Slug() == (assistant.MCPServer{Name: name}).Slug()
			}
			if !clash {
				break
			}
			name = fmt.Sprintf("%s %d", s.item.Name, n)
		}
		return a.SaveMcpServer(McpServerInput{Name: name, Type: s.item.Type, Command: s.item.Command, Args: s.item.Args, URL: s.item.URL,
			Env: s.env, Headers: s.headers})
	}
	return McpServerView{}, errors.New("that server is no longer in the CLI's configuration")
}
