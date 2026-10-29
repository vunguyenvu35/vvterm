// Package mcpgw is the MCP gateway: the only tool channel an AI agent gets. The agent talks to a loopback
// MCP endpoint of VVTerm; VVTerm talks to the real servers, so every call and every result passes the hooks.
package mcpgw

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"vvterm/internal/domain/assistant"
)

const (
	maxCallsPerRequest = 12
	maxBody            = 1 << 20
)

// Gateway serves one loopback listener for all requests; each request has its own token and servers.
type Gateway struct {
	mu       sync.Mutex
	ln       net.Listener
	srv      *http.Server
	sessions map[string]*session
}

// New returns a gateway; it listens only once the first session is opened.
func New() *Gateway { return &Gateway{sessions: map[string]*session{}} }

type session struct {
	servers map[string]assistant.ToolServer
	hooks   assistant.GatewayHooks
	mu      sync.Mutex
	calls   int
	index   map[string]route
}

type route struct{ server, tool string }

var badName = regexp.MustCompile(`[^A-Za-z0-9_-]`)

func exposed(server, tool string) string {
	n := tool
	if server != "" {
		n = server + "__" + tool
	}
	n = badName.ReplaceAllString(n, "_")
	if len(n) > 64 {
		n = n[:64]
	}
	return n
}

func (g *Gateway) start() error {
	if g.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	g.ln = ln
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", g.handle)
	g.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go g.srv.Serve(ln)
	return nil
}

// Open starts a session for one request. servers maps a name to a tool server ("" = no name prefix). The
// returned func ends the session and closes the servers.
func (g *Gateway) Open(servers map[string]assistant.ToolServer, hooks assistant.GatewayHooks) (assistant.Gateway, func(), error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if err := g.start(); err != nil {
		return assistant.Gateway{}, nil, err
	}
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return assistant.Gateway{}, nil, err
	}
	token := hex.EncodeToString(raw[:])
	g.sessions[token] = &session{servers: servers, hooks: hooks}
	end := func() {
		g.mu.Lock()
		s := g.sessions[token]
		delete(g.sessions, token)
		g.mu.Unlock()
		if s != nil {
			for _, sv := range s.servers {
				sv.Close()
			}
		}
	}
	return assistant.Gateway{URL: "http://" + g.ln.Addr().String() + "/mcp", Token: token}, end, nil
}

// Close stops the listener.
func (g *Gateway) Close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.srv != nil {
		g.srv.Close()
		g.srv, g.ln = nil, nil
	}
}

func (g *Gateway) lookup(r *http.Request) *session {
	// a browser page must not be able to reach the gateway (DNS rebinding, cross-site requests)
	if r.Header.Get("Origin") != "" || !strings.HasPrefix(r.Host, "127.0.0.1:") {
		return nil
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	g.mu.Lock()
	defer g.mu.Unlock()
	for tok, s := range g.sessions {
		if subtle.ConstantTimeCompare([]byte(tok), []byte(got)) == 1 {
			return s
		}
	}
	return nil
}

func (g *Gateway) handle(w http.ResponseWriter, r *http.Request) {
	s := g.lookup(r)
	if s == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodPost:
	case http.MethodDelete:
		w.WriteHeader(http.StatusOK)
		return
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var batch []json.RawMessage
	if strings.HasPrefix(strings.TrimSpace(string(body)), "[") {
		if json.Unmarshal(body, &batch) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
	} else {
		batch = []json.RawMessage{body}
	}
	var out [][]byte
	for _, one := range batch {
		var m rpcMsg
		if json.Unmarshal(one, &m) != nil {
			out = append(out, replyErr(nil, -32700, "parse error"))
			continue
		}
		if len(m.ID) == 0 { // a notification: nothing to answer
			continue
		}
		out = append(out, s.dispatch(m))
	}
	if len(out) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if len(out) == 1 && !strings.HasPrefix(strings.TrimSpace(string(body)), "[") {
		w.Write(out[0])
		return
	}
	w.Write([]byte("[" + string(joinRaw(out)) + "]"))
}

func joinRaw(parts [][]byte) []byte {
	return []byte(strings.Join(func() []string {
		s := make([]string, len(parts))
		for i, p := range parts {
			s[i] = string(p)
		}
		return s
	}(), ","))
}

func (s *session) dispatch(m rpcMsg) []byte {
	switch m.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(m.Params, &p)
		v := p.ProtocolVersion
		if v == "" {
			v = protocolVersion
		}
		return reply(m.ID, map[string]any{"protocolVersion": v, "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{"name": "vvterm", "version": "1"}})
	case "ping":
		return reply(m.ID, map[string]any{})
	case "tools/list":
		return reply(m.ID, map[string]any{"tools": s.listTools()})
	case "tools/call":
		return s.callTool(m)
	}
	return replyErr(m.ID, -32601, "method not found")
}

func (s *session) listTools() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.index = map[string]route{}
	var names []string
	byName := map[string]map[string]any{}
	for server, sv := range s.servers {
		tools, err := sv.Tools()
		if err != nil {
			continue
		}
		for _, t := range tools {
			if s.hooks.Visible != nil && !s.hooks.Visible(server, t) {
				continue
			}
			name := exposed(server, t.Name)
			s.index[name] = route{server, t.Name}
			schema := t.InputSchema
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object"}`)
			}
			byName[name] = map[string]any{"name": name, "description": t.Description, "inputSchema": schema}
			names = append(names, name)
		}
	}
	sort.Strings(names)
	out := []map[string]any{}
	for _, n := range names {
		out = append(out, byName[n])
	}
	return out
}

func (s *session) callTool(m rpcMsg) []byte {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(m.Params, &p) != nil {
		return replyErr(m.ID, -32602, "invalid params")
	}
	s.mu.Lock()
	rt, ok := s.index[p.Name]
	s.calls++
	over := s.calls > maxCallsPerRequest
	s.mu.Unlock()
	if !ok {
		return replyErr(m.ID, -32602, "unknown tool")
	}
	text := func(msg string, isErr bool) []byte {
		return reply(m.ID, map[string]any{"content": []map[string]string{{"type": "text", "text": msg}}, "isError": isErr})
	}
	observe := func(state, note string) {
		if s.hooks.Observe != nil {
			s.hooks.Observe(rt.server, rt.tool, state, note)
		}
	}
	if over {
		observe("blocked", "too many tool calls in one request")
		return text("blocked: too many tool calls in this request", true)
	}
	if len(p.Arguments) == 0 {
		p.Arguments = json.RawMessage(`{}`)
	}
	if s.hooks.Authorize != nil {
		if err := s.hooks.Authorize(rt.server, rt.tool, p.Arguments); err != nil {
			observe("blocked", err.Error())
			return text("blocked: "+err.Error(), true)
		}
	}
	observe("calling", "")
	res, err := s.servers[rt.server].Call(rt.tool, p.Arguments)
	if err != nil {
		observe("failed", err.Error())
		msg := err.Error()
		if s.hooks.Clean != nil {
			msg = s.hooks.Clean(msg)
		}
		return text("error: "+msg, true)
	}
	out := res.Text
	if s.hooks.Clean != nil {
		out = s.hooks.Clean(out)
	}
	observe("done", "")
	return text(out, res.IsError)
}
