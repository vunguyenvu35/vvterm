package mcpgw

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"vvterm/internal/agentx"
	"vvterm/internal/domain/assistant"
)

const callTimeout = 45 * time.Second

// transport carries JSON-RPC to one MCP server.
type transport interface {
	call(method string, params any) (json.RawMessage, error)
	notify(method string) error
	close()
}

// client is an assistant.ToolServer on top of a transport.
type client struct {
	t     transport
	extra func()
}

func newClient(t transport, extra func()) (*client, error) {
	c := &client{t: t, extra: extra}
	if _, err := t.call("initialize", map[string]any{"protocolVersion": protocolVersion, "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "vvterm", "version": "1"}}); err != nil {
		t.close()
		if extra != nil {
			extra()
		}
		return nil, fmt.Errorf("initialize: %w", err)
	}
	_ = t.notify("notifications/initialized")
	return c, nil
}

func (c *client) Tools() ([]assistant.Tool, error) {
	var out []assistant.Tool
	cursor := ""
	for page := 0; page < 5; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.t.call("tools/list", params)
		if err != nil {
			return nil, err
		}
		var r struct {
			Tools      []toolWire `json:"tools"`
			NextCursor string     `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, err
		}
		for _, t := range r.Tools {
			out = append(out, assistant.Tool{Name: t.Name, Description: t.Description, InputSchema: t.InputSchema, ReadOnly: t.Annotations.ReadOnlyHint})
		}
		if r.NextCursor == "" {
			break
		}
		cursor = r.NextCursor
	}
	return out, nil
}

func (c *client) Call(name string, args json.RawMessage) (assistant.ToolResult, error) {
	raw, err := c.t.call("tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return assistant.ToolResult{}, err
	}
	var r callResultWire
	if err := json.Unmarshal(raw, &r); err != nil {
		return assistant.ToolResult{}, err
	}
	var parts []string
	for _, c := range r.Content {
		if c.Type == "text" {
			parts = append(parts, c.Text)
		}
	}
	return assistant.ToolResult{Text: strings.Join(parts, "\n"), IsError: r.IsError}, nil
}

func (c *client) Close() {
	c.t.close()
	if c.extra != nil {
		c.extra()
	}
}

// ---- stdio ----

type stdioTransport struct {
	cmd     *exec.Cmd
	in      io.WriteCloser
	mu      sync.Mutex
	id      int
	pending map[int]chan rpcMsg
	dead    error
}

func (s *stdioTransport) readLoop(r io.Reader) {
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, err := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var m rpcMsg
			if json.Unmarshal(line, &m) == nil && len(m.ID) > 0 && m.Method == "" {
				var id int
				if json.Unmarshal(m.ID, &id) == nil {
					s.mu.Lock()
					ch := s.pending[id]
					delete(s.pending, id)
					s.mu.Unlock()
					if ch != nil {
						ch <- m
					}
				}
			}
		}
		if err != nil {
			s.mu.Lock()
			s.dead = errors.New("the MCP server stopped")
			for id, ch := range s.pending {
				close(ch)
				delete(s.pending, id)
			}
			s.mu.Unlock()
			return
		}
	}
}

func (s *stdioTransport) call(method string, params any) (json.RawMessage, error) {
	s.mu.Lock()
	if s.dead != nil {
		s.mu.Unlock()
		return nil, s.dead
	}
	s.id++
	id := s.id
	ch := make(chan rpcMsg, 1)
	s.pending[id] = ch
	p, _ := json.Marshal(params)
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": json.RawMessage(p)})
	_, err := s.in.Write(append(line, '\n'))
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return nil, errors.New("the MCP server stopped")
		}
		if m.Error != nil {
			return nil, m.Error
		}
		return m.Result, nil
	case <-time.After(callTimeout):
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, errors.New("the MCP server did not answer in time")
	}
}

func (s *stdioTransport) notify(method string) error {
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method})
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.in.Write(append(line, '\n'))
	return err
}

func (s *stdioTransport) close() {
	s.in.Close()
	if s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
	go s.cmd.Wait()
}

// ---- HTTP (streamable) ----

type httpTransport struct {
	url     string
	headers map[string]string
	hc      *http.Client
	mu      sync.Mutex
	id      int
	session string
}

func (h *httpTransport) post(body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, h.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range h.headers {
		req.Header.Set(k, v)
	}
	h.mu.Lock()
	if h.session != "" {
		req.Header.Set("Mcp-Session-Id", h.session)
	}
	h.mu.Unlock()
	resp, err := h.hc.Do(req)
	if err != nil {
		return nil, err
	}
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		h.mu.Lock()
		h.session = sid
		h.mu.Unlock()
	}
	return resp, nil
}

func (h *httpTransport) call(method string, params any) (json.RawMessage, error) {
	h.mu.Lock()
	h.id++
	id := h.id
	h.mu.Unlock()
	p, _ := json.Marshal(params)
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": json.RawMessage(p)})
	resp, err := h.post(body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("the MCP server answered HTTP %d", resp.StatusCode)
	}
	var found *rpcMsg
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 64<<10), maxBody*8)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			var m rpcMsg
			if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &m) == nil && string(m.ID) == fmt.Sprint(id) && m.Method == "" {
				found = &m
				break
			}
		}
	} else {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody*8))
		var m rpcMsg
		if json.Unmarshal(b, &m) == nil {
			found = &m
		}
	}
	if found == nil {
		return nil, errors.New("no answer from the MCP server")
	}
	if found.Error != nil {
		return nil, found.Error
	}
	return found.Result, nil
}

func (h *httpTransport) notify(method string) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method})
	resp, err := h.post(body)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (h *httpTransport) close() {}

// Connector starts or reaches user MCP servers. It implements usecase.MCPConnector.
type Connector struct{}

// Connect opens a server. env and headers hold the already decrypted values.
func (Connector) Connect(s assistant.MCPServer, env, headers map[string]string) (assistant.ToolServer, error) {
	switch s.Type {
	case assistant.MCPHTTP:
		return newClient(&httpTransport{url: s.URL, headers: headers, hc: &http.Client{Timeout: callTimeout}}, nil)
	case assistant.MCPStdio:
		bin := s.Command
		if !strings.ContainsAny(bin, `/\`) {
			if p := agentx.FindBinary(bin); p != "" {
				bin = p
			}
		}
		dir, err := os.MkdirTemp("", "vvterm-mcp-*")
		if err != nil {
			return nil, err
		}
		cleanup := func() { os.RemoveAll(dir) }
		cmd := exec.Command(bin, s.Args...)
		cmd.Dir = dir
		cmd.Env = agentx.BaseEnv()
		for k, v := range env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		in, err := cmd.StdinPipe()
		if err != nil {
			cleanup()
			return nil, err
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			cleanup()
			return nil, err
		}
		if err := cmd.Start(); err != nil {
			cleanup()
			return nil, fmt.Errorf("cannot start %s: %w", s.Command, err)
		}
		t := &stdioTransport{cmd: cmd, in: in, pending: map[int]chan rpcMsg{}}
		go t.readLoop(out)
		return newClient(t, cleanup)
	}
	return nil, errors.New("unknown MCP server type")
}
