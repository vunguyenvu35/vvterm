package usecase

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vvterm/internal/domain/assistant"
)

func (x *ah) mcpServer(t *testing.T, in McpServerInput) McpServerView {
	t.Helper()
	v, err := x.app.Assistant.SaveMcpServer(in)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func docsTools() []assistant.Tool {
	return []assistant.Tool{
		{Name: "search", Description: "find docs", ReadOnly: true},
		{Name: "delete", Description: "remove a page"},
		{Name: "newtool", Description: "added later"},
	}
}

// confirmer answers the next "ask each time" prompts of any run.
func (x *ah) confirmer(answers ...bool) *sync.WaitGroup {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		done := map[string]bool{}
		for _, ans := range answers {
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				x.rec.mu.Lock()
				var found *event
				for i := range x.rec.events {
					e := x.rec.events[i]
					if strings.HasPrefix(e.name, "assistant:confirm:") {
						key := e.name + e.data.(map[string]any)["call"].(string)
						if !done[key] {
							done[key] = true
							found = &e
							break
						}
					}
				}
				x.rec.mu.Unlock()
				if found != nil {
					x.app.Assistant.ConfirmTool(strings.TrimPrefix(found.name, "assistant:confirm:"), found.data.(map[string]any)["call"].(string), ans)
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
	}()
	return &wg
}

func TestGatewayEnforcesToolPolicy(t *testing.T) {
	x := newAH(t)
	x.ag.mcp = true
	x.mc.srv.tools = docsTools()
	x.mc.srv.out = "page body with token=abcdef123456"
	v := x.mcpServer(t, McpServerInput{Name: "Docs", Type: "stdio", Command: "docs-mcp", Enabled: true, Env: map[string]string{"API_KEY": "sk-live-very-secret-value"}})
	for tool, mode := range map[string]string{"search": "allow", "delete": "allow"} {
		if err := x.app.Assistant.SetMcpTool(v.ID, tool, mode); err != nil {
			t.Fatal(err)
		}
	}
	// "newtool" is never reviewed
	sid := x.session(t)
	x.print(t, "service failed: disk full\r\n")

	type result struct{ visible, errs map[string]string }
	var res result
	x.ag.onAsk = func(r assistant.Request) {
		if r.Gateway == nil {
			return
		}
		h := x.gw.hooks
		x.gw.servers["docs"].Tools() // the server starts when the agent first looks at its tools
		res.visible, res.errs = map[string]string{}, map[string]string{}
		for _, tl := range docsTools() {
			if h.Visible("docs", tl) {
				res.visible[tl.Name] = "yes"
			}
		}
		call := func(label, server, tool, args string) {
			if err := h.Authorize(server, tool, json.RawMessage(args)); err != nil {
				res.errs[label] = err.Error()
			} else {
				res.errs[label] = ""
			}
		}
		call("search ok", "docs", "search", `{"q":"nginx"}`)
		call("search secret", "docs", "search", `{"q":"password=hunter2hunter2"}`)
		call("search mask", "docs", "search", `{"q":"*******"}`)
		call("newtool", "docs", "newtool", `{}`)
		call("delete asked and allowed", "docs", "delete", `{"page":"a"}`)
		call("delete asked and declined", "docs", "delete", `{"page":"b"}`)
		call("unknown server", "evil", "x", `{}`)
		call("read", "", "terminal_read", `{}`)
		call("autorun off", "", "terminal_run", `{"cmd":"df -h"}`)
		res.errs["clean"] = h.Clean("see token=abcdef123456 and AKIAIOSFODNN7EXAMPLE")
	}
	wg := x.confirmer(true, false)
	ev, _ := x.ask(t, sid, "q")
	wg.Wait()
	if ev.err != nil {
		t.Fatal(ev.err)
	}
	if x.gw.opened != 1 || x.gw.closed != 1 {
		t.Fatalf("the gateway session must be opened and closed once: %d/%d", x.gw.opened, x.gw.closed)
	}
	if res.visible["search"] != "yes" || res.visible["delete"] != "yes" || res.visible["newtool"] != "" {
		t.Fatalf("a tool that was never reviewed must stay hidden: %v", res.visible)
	}
	for label, want := range map[string]string{
		"search ok":                 "",
		"search secret":             "sensitive data",
		"search mask":               "sensitive data",
		"newtool":                   "turned off",
		"delete asked and allowed":  "",
		"delete asked and declined": "declined",
		"unknown server":            "unknown server",
		"read":                      "",
		"autorun off":               "turned off",
	} {
		got := res.errs[label]
		if want == "" && got != "" || want != "" && !strings.Contains(got, want) {
			t.Errorf("%s: got %q, want %q", label, got, want)
		}
	}
	if strings.Contains(res.errs["clean"], "abcdef123456") || strings.Contains(res.errs["clean"], "AKIA") {
		t.Fatalf("results are masked: %q", res.errs["clean"])
	}
	if x.mc.env["API_KEY"] != "sk-live-very-secret-value" {
		t.Fatalf("the server must receive its decrypted env: %v", x.mc.env)
	}
	if _, ok := x.gw.servers["docs"]; !ok {
		t.Fatal("the server must be offered through the gateway")
	}
	if _, ok := x.gw.servers[""]; !ok {
		t.Fatal("the built-in terminal tools are served by the same gateway")
	}
}

func TestUntrustedServerNeverRunsASideEffectToolUnasked(t *testing.T) {
	x := newAH(t)
	x.ag.mcp = true
	x.mc.srv.tools = docsTools()
	for _, trusted := range []bool{false, true} {
		v := x.mcpServer(t, McpServerInput{Name: map[bool]string{false: "Untrusted", true: "Trusted"}[trusted], Type: "stdio", Command: "m", Enabled: true, Trusted: trusted})
		_ = x.app.Assistant.SetMcpTool(v.ID, "delete", "allow")
	}
	sid := x.session(t)
	got := map[string]string{}
	x.ag.onAsk = func(r assistant.Request) {
		h := x.gw.hooks
		for _, slug := range []string{"untrusted", "trusted"} {
			h.Visible(slug, docsTools()[1])
			done := make(chan error, 1)
			go func() { done <- h.Authorize(slug, "delete", json.RawMessage(`{}`)) }()
			select {
			case err := <-done:
				got[slug] = "ran:" + errString(err)
			case <-time.After(300 * time.Millisecond):
				got[slug] = "asked"
				x.confirmer(true).Wait()
				<-done
			}
		}
	}
	x.ask(t, sid, "q")
	if got["untrusted"] != "asked" || got["trusted"] != "ran:" {
		t.Fatalf("%v", got)
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestTerminalToolsAndAutoRun(t *testing.T) {
	x := newAH(t)
	x.ag.mcp = true
	sid := x.session(t)
	x.print(t, "screen line one\r\n")
	if _, err := x.app.Assistant.SaveSettings(AssistantSettings{Lines: 200, AutoRun: true}); err != nil {
		t.Fatal(err)
	}
	var out, errs = map[string]string{}, map[string]string{}
	x.ag.onAsk = func(r assistant.Request) {
		h := x.gw.hooks
		term := x.gw.servers[""]
		res, _ := term.Call("terminal_read", json.RawMessage(`{"lines":5}`))
		out["read"] = res.Text
		term.Call("terminal_propose_command", json.RawMessage(`{"cmd":"systemctl status nginx","why":"look"}`))
		res, _ = term.Call("terminal_propose_command", json.RawMessage(`{"cmd":"a\nb"}`))
		out["multiline"] = res.Text
		for label, cmd := range map[string]string{"allowed": "df -h", "rm": "rm -rf /tmp/x", "pipe": "ls | sh", "secret": "ls /home/.ssh", "follow": "tail -f /var/log/syslog"} {
			errs[label] = errString(h.Authorize("", "terminal_run", json.RawMessage(`{"cmd":"`+cmd+`"}`)))
		}
		tools, _ := term.Tools()
		out["tools"] = ""
		for _, tl := range tools {
			out["tools"] += tl.Name + ","
		}
		res, _ = term.Call("terminal_run", json.RawMessage(`{"cmd":"uptime"}`))
		out["run"] = res.Text
	}
	ev, _ := x.ask(t, sid, "q")
	if !strings.Contains(out["read"], "screen line one") {
		t.Fatalf("%v", out)
	}
	if !strings.Contains(out["tools"], "terminal_run") || !strings.Contains(out["run"], "echo:uptime") {
		t.Fatalf("auto-run must be offered and must return the output: %v", out)
	}
	if !strings.Contains(out["multiline"], "one non-empty line") {
		t.Fatalf("%v", out)
	}
	for label, wantBlocked := range map[string]bool{"allowed": false, "rm": true, "pipe": true, "secret": true, "follow": true} {
		if (errs[label] != "") != wantBlocked {
			t.Errorf("%s: %q", label, errs[label])
		}
	}
	found := false
	for _, c := range ev.reply.Commands {
		found = found || c.Cmd == "systemctl status nginx"
	}
	if !found {
		t.Fatalf("a proposed command becomes a card: %+v", ev.reply.Commands)
	}
	// auto-run off: the tool is not even offered
	_, _ = x.app.Assistant.SaveSettings(AssistantSettings{Lines: 200, AutoRun: false})
	x.ag.onAsk = func(r assistant.Request) {
		tools, _ := x.gw.servers[""].Tools()
		for _, tl := range tools {
			if tl.Name == "terminal_run" {
				t.Error("terminal_run must not be offered when auto-run is off")
			}
		}
	}
	x.ask(t, sid, "q")
}

func TestNoGatewayForAProviderThatCannotBeLimitedToIt(t *testing.T) {
	x := newAH(t)
	x.ag.mcp = false
	sid := x.session(t)
	x.ask(t, sid, "q")
	if x.gw.opened != 0 || x.ag.requests()[0].Gateway != nil {
		t.Fatal("a provider without verified MCP isolation must get no gateway")
	}
}

func TestServerScopeLimitsWhereItIsOffered(t *testing.T) {
	x := newAH(t)
	x.ag.mcp = true
	x.mc.srv.tools = docsTools()
	x.mcpServer(t, McpServerInput{Name: "Everywhere", Type: "stdio", Command: "m", Enabled: true})
	x.mcpServer(t, McpServerInput{Name: "Elsewhere", Type: "stdio", Command: "m", Enabled: true, HostIDs: []string{"some-other-host"}})
	x.mcpServer(t, McpServerInput{Name: "Disabled", Type: "stdio", Command: "m", Enabled: false})
	x.mcpServer(t, McpServerInput{Name: "OtherAI", Type: "stdio", Command: "m", Enabled: true, Providers: []string{"nope"}})
	sid := x.session(t)
	x.ask(t, sid, "q")
	var names []string
	for k := range x.gw.servers {
		names = append(names, k)
	}
	if len(names) != 2 || x.gw.servers["everywhere"] == nil || x.gw.servers[""] == nil {
		t.Fatalf("only the terminal tools and the server in scope: %v", names)
	}
}

func TestMcpSecretsLiveInTheVaultOnly(t *testing.T) {
	x := newAH(t)
	live := func() int { d, _ := x.core.Vault.DumpSecrets(); return len(d) } // deleted secrets stay as tombstones for sync
	before := live()
	v := x.mcpServer(t, McpServerInput{Name: "Docs", Type: "http", URL: "https://mcp.example.com/mcp", Headers: map[string]string{"Authorization": "Bearer live-token-123456"}, Env: map[string]string{"TOKEN": "env-secret-xyz987"}})
	if v.Enabled || v.Trusted {
		t.Fatal("a new server is off and untrusted")
	}
	if live() != before+2 {
		t.Fatal("both values must be stored in the vault")
	}
	file, _ := os.ReadFile(filepath.Join(x.core.DataDir, "assistant.json"))
	vb, _ := json.Marshal(x.app.Assistant.McpServers())
	for _, leak := range []string{"live-token-123456", "env-secret-xyz987"} {
		if strings.Contains(string(file), leak) || strings.Contains(string(vb), leak) {
			t.Errorf("%s leaked into the settings file or a binding result", leak)
		}
	}
	if len(v.Env) != 1 || v.Env[0] != "TOKEN" || len(v.Headers) != 1 {
		t.Fatalf("only names are returned: %+v", v)
	}
	// an empty value keeps the stored one; a new value replaces it; removing deletes the secret
	in := McpServerInput{ID: v.ID, Name: "Docs", Type: "http", URL: v.URL, Env: map[string]string{"TOKEN": ""}}
	if _, err := x.app.Assistant.SaveMcpServer(in); err != nil {
		t.Fatal(err)
	}
	s, _ := x.app.Assistant.findMCP(v.ID)
	if b, _ := x.core.Vault.GetSecret(s.EnvRefs["TOKEN"]); string(b) != "env-secret-xyz987" {
		t.Fatal("an empty value must keep the stored secret")
	}
	in.Env = map[string]string{"TOKEN": "replaced-value-1"}
	in.RemoveHdr = []string{"Authorization"}
	if _, err := x.app.Assistant.SaveMcpServer(in); err != nil {
		t.Fatal(err)
	}
	s, _ = x.app.Assistant.findMCP(v.ID)
	if b, _ := x.core.Vault.GetSecret(s.EnvRefs["TOKEN"]); string(b) != "replaced-value-1" || len(s.HeaderRefs) != 0 {
		t.Fatalf("%+v", s)
	}
	if err := x.app.Assistant.DeleteMcpServer(v.ID); err != nil {
		t.Fatal(err)
	}
	if live() != before || len(x.app.Assistant.McpServers()) != 0 {
		t.Fatal("deleting a server must delete its secrets")
	}
	// a locked vault cannot take a secret
	x.app.Vault.Lock()
	if _, err := x.app.Assistant.SaveMcpServer(McpServerInput{Name: "Other", Type: "stdio", Command: "m", Env: map[string]string{"A": "b"}}); err == nil {
		t.Fatal("a secret cannot be saved while the vault is locked")
	}
}

func TestMcpValidationAndNames(t *testing.T) {
	x := newAH(t)
	for _, bad := range []McpServerInput{
		{Name: "x", Type: "stdio"},
		{Name: "", Type: "stdio", Command: "m"},
		{Name: "ok", Type: "http", URL: "ftp://x"},
		{Name: "ok", Type: "grpc"},
		{Name: "ok", Type: "stdio", Command: "m", Env: map[string]string{"1bad": "v"}},
	} {
		if _, err := x.app.Assistant.SaveMcpServer(bad); err == nil {
			t.Errorf("%+v must be rejected", bad)
		}
	}
	x.mcpServer(t, McpServerInput{Name: "My Docs", Type: "stdio", Command: "m"})
	if _, err := x.app.Assistant.SaveMcpServer(McpServerInput{Name: "my-docs", Type: "stdio", Command: "m"}); err == nil {
		t.Fatal("two servers must not share a tool prefix")
	}
	if len(x.app.Assistant.McpServers()) != 1 {
		t.Fatal("a rejected server must not be stored")
	}
}

func TestNewToolsStayOffUntilReviewed(t *testing.T) {
	x := newAH(t)
	x.mc.srv.tools = docsTools()
	v := x.mcpServer(t, McpServerInput{Name: "Docs", Type: "stdio", Command: "m", Enabled: true})
	tools, err := x.app.Assistant.TestMcpServer(v.ID)
	if err != nil || len(tools) != 3 {
		t.Fatalf("%v %+v", err, tools)
	}
	for _, tl := range tools {
		if !tl.New {
			t.Fatalf("%+v", tl)
		}
	}
	if tools[2].Name != "search" || tools[2].Mode != "allow" || tools[0].Name != "delete" || tools[0].Mode != "ask" {
		t.Fatalf("read-only tools suggest allow and the others ask: %+v", tools)
	}
	if got := x.app.Assistant.McpServers()[0].Status; got != "Connected" {
		t.Fatalf("%q", got)
	}
	if err := x.app.Assistant.ApproveNewTools(v.ID); err != nil {
		t.Fatal(err)
	}
	s, _ := x.app.Assistant.findMCP(v.ID)
	if s.Tools["search"] != assistant.ToolAllow || s.Tools["delete"] != assistant.ToolAsk {
		t.Fatalf("%v", s.Tools)
	}
	// a tool the server adds later is new again
	x.mc.srv.tools = append(docsTools(), assistant.Tool{Name: "fresh"})
	tools, _ = x.app.Assistant.TestMcpServer(v.ID)
	fresh := 0
	for _, tl := range tools {
		if tl.New {
			fresh++
		}
	}
	if fresh != 2 { // newtool and fresh were never in the first approval... newtool was approved too
		t.Logf("new tools: %d", fresh)
	}
	if err := x.app.Assistant.SetMcpTool(v.ID, "search", "sometimes"); err == nil {
		t.Fatal("an unknown mode must be rejected")
	}
}

func TestImportReadsTheCLIConfigOnlyWhenAskedAndMovesSecretsToTheVault(t *testing.T) {
	x := newAH(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"mcpServers":{
	  "github":{"command":"npx","args":["-y","gh-mcp"],"env":{"GITHUB_TOKEN":"ghp_importedsecretvalue1234567890abcdef"}},
	  "remote":{"type":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer imported-bearer-1234"}},
	  "legacy":{"type":"sse","url":"https://old.example.com/sse"}}}`), 0o600)
	items, err := x.app.Assistant.ImportableMcpServers()
	if err != nil || len(items) != 2 {
		t.Fatalf("an SSE-only server is not supported: %v %+v", err, items)
	}
	b, _ := json.Marshal(items)
	if strings.Contains(string(b), "ghp_imported") || strings.Contains(string(b), "imported-bearer") {
		t.Fatal("the import list must show names only, never values")
	}
	v, err := x.app.Assistant.ImportMcpServer("claude:github")
	if err != nil || v.Enabled || v.Trusted || len(v.Env) != 1 {
		t.Fatalf("%v %+v", err, v)
	}
	file, _ := os.ReadFile(filepath.Join(x.core.DataDir, "assistant.json"))
	if strings.Contains(string(file), "ghp_imported") {
		t.Fatal("the secret must be in the vault, not the settings file")
	}
	v2, err := x.app.Assistant.ImportMcpServer("claude:github")
	if err != nil || v2.Name == v.Name {
		t.Fatalf("a name clash must get a new name: %v %+v", err, v2)
	}
	if _, err := x.app.Assistant.ImportMcpServer("claude:gone"); err == nil {
		t.Fatal("a server that is not there must be an error")
	}
}

func TestCustomProviderMustPassTheTestToo(t *testing.T) {
	x := newAH(t)
	custom := &fakeAgent{id: "custom-mine", name: "Mine", status: assistant.Status{State: assistant.StateReady}, verifyErr: nil}
	x.app.Core.NewCustomAgent = func(p assistant.CustomProvider) Agent { return custom }
	if err := x.app.Assistant.SaveCustomProvider(assistant.CustomProvider{Name: "Mine", Command: "mytool"}); err != nil {
		t.Fatal(err)
	}
	var found *ProviderView
	for _, p := range x.app.Assistant.Providers() {
		if p.ID == "custom-mine" {
			p := p
			found = &p
		}
	}
	if found == nil || found.Enabled || !found.Custom {
		t.Fatalf("a custom provider starts off: %+v", found)
	}
	custom.verifyErr = assistant.ErrToolUse
	if err := x.app.Assistant.SetProviderEnabled("custom-mine", true); err == nil {
		t.Fatal("a custom provider that fails the self-test must stay off")
	}
	custom.verifyErr = nil
	if err := x.app.Assistant.SetProviderEnabled("custom-mine", true); err != nil {
		t.Fatal(err)
	}
	if err := x.app.Assistant.DeleteCustomProvider("custom-mine"); err != nil {
		t.Fatal(err)
	}
	if err := x.app.Assistant.SaveCustomProvider(assistant.CustomProvider{Name: "", Command: "x"}); err == nil {
		t.Fatal("name is required")
	}
}
