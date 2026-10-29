package mcpgw

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"vvterm/internal/domain/assistant"
)

// TestMain lets the test binary act as a tiny stdio MCP server.
func TestMain(m *testing.M) {
	if os.Getenv("MCPGW_FAKE_SERVER") == "1" {
		fakeServer()
		return
	}
	os.Exit(m.Run())
}

func fakeServer() {
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var m rpcMsg
		if json.Unmarshal(sc.Bytes(), &m) != nil || len(m.ID) == 0 {
			continue
		}
		switch m.Method {
		case "initialize":
			fmt.Println(string(reply(m.ID, map[string]any{"protocolVersion": protocolVersion, "capabilities": map[string]any{}})))
		case "tools/list":
			fmt.Println(string(reply(m.ID, map[string]any{"tools": []map[string]any{
				{"name": "search", "description": "find docs", "inputSchema": map[string]any{"type": "object"}, "annotations": map[string]any{"readOnlyHint": true}},
				{"name": "delete", "description": "remove"},
			}})))
		case "tools/call":
			var p struct {
				Name string          `json:"name"`
				Args json.RawMessage `json:"arguments"`
			}
			json.Unmarshal(m.Params, &p)
			fmt.Println(string(reply(m.ID, map[string]any{"content": []map[string]string{{"type": "text", "text": "result of " + p.Name + " " + string(p.Args) + " token=" + os.Getenv("FAKE_TOKEN")}}})))
		}
	}
}

func connectFake(t *testing.T, env map[string]string) assistant.ToolServer {
	t.Helper()
	exe, _ := os.Executable()
	e := map[string]string{"MCPGW_FAKE_SERVER": "1"}
	for k, v := range env {
		e[k] = v
	}
	s, err := Connector{}.Connect(assistant.MCPServer{Name: "Docs", Type: assistant.MCPStdio, Command: exe}, e, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestStdioServerToolsAndCall(t *testing.T) {
	s := connectFake(t, map[string]string{"FAKE_TOKEN": "abc"})
	tools, err := s.Tools()
	if err != nil || len(tools) != 2 || !tools[0].ReadOnly || tools[1].ReadOnly {
		t.Fatalf("%v %+v", err, tools)
	}
	res, err := s.Call("search", json.RawMessage(`{"q":"x"}`))
	if err != nil || !strings.Contains(res.Text, `result of search {"q":"x"}`) || !strings.Contains(res.Text, "token=abc") {
		t.Fatalf("%v %+v", err, res)
	}
}

func TestStdioServerGetsOnlyTheEnvironmentItWasGiven(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "leak")
	s := connectFake(t, nil)
	res, _ := s.Call("search", json.RawMessage(`{}`))
	if strings.Contains(res.Text, "leak") || strings.Contains(res.Text, "token=x") {
		t.Fatal(res.Text)
	}
}

func rpc(t *testing.T, url, token, body string, hdr map[string]string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestGatewayAuthAndOrigin(t *testing.T) {
	g := New()
	defer g.Close()
	ep, end, err := g.Open(map[string]assistant.ToolServer{}, assistant.GatewayHooks{})
	if err != nil {
		t.Fatal(err)
	}
	defer end()
	body := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	if c, _ := rpc(t, ep.URL, "", body, nil); c != 401 {
		t.Fatalf("no token: %d", c)
	}
	if c, _ := rpc(t, ep.URL, "wrong", body, nil); c != 401 {
		t.Fatalf("wrong token: %d", c)
	}
	if c, _ := rpc(t, ep.URL, ep.Token, body, map[string]string{"Origin": "http://evil.example"}); c != 401 {
		t.Fatalf("browser origin must be refused: %d", c)
	}
	if c, b := rpc(t, ep.URL, ep.Token, body, nil); c != 200 || !strings.Contains(b, `"result"`) {
		t.Fatalf("%d %s", c, b)
	}
	end()
	if c, _ := rpc(t, ep.URL, ep.Token, body, nil); c != 401 {
		t.Fatalf("a finished session must be refused: %d", c)
	}
}

func TestGatewayAppliesTheHooks(t *testing.T) {
	g := New()
	defer g.Close()
	srv := connectFake(t, nil)
	var seen []string
	hooks := assistant.GatewayHooks{
		Visible: func(server string, tl assistant.Tool) bool { return tl.Name != "delete" },
		Authorize: func(server, tool string, args json.RawMessage) error {
			if strings.Contains(string(args), "secret") {
				return errors.New("arguments contain sensitive data")
			}
			return nil
		},
		Clean:   func(s string) string { return strings.ReplaceAll(s, "token=", "token=*******") },
		Observe: func(server, tool, state, note string) { seen = append(seen, server+"/"+tool+":"+state) },
	}
	ep, end, err := g.Open(map[string]assistant.ToolServer{"docs": srv}, hooks)
	if err != nil {
		t.Fatal(err)
	}
	defer end()
	_, list := rpc(t, ep.URL, ep.Token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, nil)
	if !strings.Contains(list, `"docs__search"`) || strings.Contains(list, "delete") {
		t.Fatalf("a hidden tool must not be offered: %s", list)
	}
	_, ok := rpc(t, ep.URL, ep.Token, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"docs__search","arguments":{"q":"x"}}}`, nil)
	if !strings.Contains(ok, "token=*******") || strings.Contains(ok, `"isError":true`) {
		t.Fatalf("result must be cleaned: %s", ok)
	}
	_, blocked := rpc(t, ep.URL, ep.Token, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"docs__search","arguments":{"q":"secret"}}}`, nil)
	if !strings.Contains(blocked, "blocked: arguments contain sensitive data") || !strings.Contains(blocked, `"isError":true`) {
		t.Fatalf("%s", blocked)
	}
	_, unknown := rpc(t, ep.URL, ep.Token, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"docs__delete","arguments":{}}}`, nil)
	if !strings.Contains(unknown, "unknown tool") {
		t.Fatalf("a tool that was never offered must not be callable: %s", unknown)
	}
	if got := strings.Join(seen, ","); got != "docs/search:calling,docs/search:done,docs/search:blocked" {
		t.Fatalf("observed %s", got)
	}
}

func TestGatewayCapsCalls(t *testing.T) {
	g := New()
	defer g.Close()
	srv := connectFake(t, nil)
	ep, end, _ := g.Open(map[string]assistant.ToolServer{"docs": srv}, assistant.GatewayHooks{})
	defer end()
	rpc(t, ep.URL, ep.Token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, nil)
	var last string
	for i := 0; i < maxCallsPerRequest+2; i++ {
		_, last = rpc(t, ep.URL, ep.Token, fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"docs__search","arguments":{}}}`, i+10), nil)
	}
	if !strings.Contains(last, "too many tool calls") {
		t.Fatalf("%s", last)
	}
}

func TestHTTPServerJSONAndSSE(t *testing.T) {
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Key") != "k1" {
			http.Error(w, "no", 401)
			return
		}
		var m rpcMsg
		json.NewDecoder(r.Body).Decode(&m)
		if len(m.ID) == 0 {
			w.WriteHeader(202)
			return
		}
		var out []byte
		switch m.Method {
		case "initialize":
			out = reply(m.ID, map[string]any{"protocolVersion": protocolVersion})
		case "tools/list":
			out = reply(m.ID, map[string]any{"tools": []map[string]any{{"name": "ping"}}})
		default:
			out = reply(m.ID, map[string]any{"content": []map[string]string{{"type": "text", "text": "pong"}}})
		}
		if m.Method == "tools/call" { // this one answers as an event stream
			w.Header().Set("Content-Type", "text/event-stream")
			io.Copy(w, bytes.NewReader([]byte("event: message\ndata: "+string(out)+"\n\n")))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
	}))
	defer hs.Close()
	s, err := Connector{}.Connect(assistant.MCPServer{Name: "R", Type: assistant.MCPHTTP, URL: hs.URL}, nil, map[string]string{"X-Key": "k1"})
	if err != nil {
		t.Fatal(err)
	}
	if tools, err := s.Tools(); err != nil || len(tools) != 1 {
		t.Fatalf("%v %v", err, tools)
	}
	if res, err := s.Call("ping", nil); err != nil || res.Text != "pong" {
		t.Fatalf("%v %+v", err, res)
	}
	if _, err := (Connector{}).Connect(assistant.MCPServer{Name: "R", Type: assistant.MCPHTTP, URL: hs.URL}, nil, map[string]string{"X-Key": "bad"}); err == nil {
		t.Fatal("a refused connection must be an error")
	}
}

func TestConnectErrors(t *testing.T) {
	if _, err := (Connector{}).Connect(assistant.MCPServer{Name: "X", Type: assistant.MCPStdio, Command: "/definitely/not/here"}, nil, nil); err == nil {
		t.Fatal("missing command must fail")
	}
	if _, err := (Connector{}).Connect(assistant.MCPServer{Name: "X", Type: "weird"}, nil, nil); err == nil {
		t.Fatal("unknown type must fail")
	}
}
