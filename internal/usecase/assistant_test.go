package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/domain/assistant"
)

type fakeAgent struct {
	id, name  string
	mcp       bool
	status    assistant.Status
	models    []assistant.Model
	modelsErr error
	verifyErr error
	reply     string
	chunks    []string
	askErr    error
	onAsk     func(r assistant.Request)

	mu         sync.Mutex
	reqs       []assistant.Request
	verifies   int
	modelCalls int
}

func (f *fakeAgent) ID() string        { return f.id }
func (f *fakeAgent) Name() string      { return f.name }
func (f *fakeAgent) SupportsMCP() bool { return f.mcp }
func (f *fakeAgent) Detect(ctx context.Context) assistant.Status {
	return f.status
}
func (f *fakeAgent) Models(ctx context.Context) ([]assistant.Model, error) {
	f.mu.Lock()
	f.modelCalls++
	f.mu.Unlock()
	return f.models, f.modelsErr
}
func (f *fakeAgent) Verify(ctx context.Context) error {
	f.mu.Lock()
	f.verifies++
	f.mu.Unlock()
	return f.verifyErr
}
func (f *fakeAgent) Ask(ctx context.Context, r assistant.Request, emit func(string)) (string, error) {
	f.mu.Lock()
	f.reqs = append(f.reqs, r)
	f.mu.Unlock()
	if f.onAsk != nil {
		f.onAsk(r)
	}
	for _, c := range f.chunks {
		emit(c)
	}
	return f.reply, f.askErr
}
func (f *fakeAgent) requests() []assistant.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]assistant.Request(nil), f.reqs...)
}

// wire is everything the agent was sent, as one string.
func wire(r assistant.Request) string {
	var b strings.Builder
	b.WriteString(r.System.String() + "\n" + r.Context.String() + "\n" + r.Question.String() + "\n")
	for _, t := range r.History {
		b.WriteString(t.Text.String() + "\n")
	}
	return b.String()
}

type fakeGateway struct {
	mu      sync.Mutex
	servers map[string]assistant.ToolServer
	hooks   assistant.GatewayHooks
	opened  int
	closed  int
}

func (g *fakeGateway) Open(s map[string]assistant.ToolServer, h assistant.GatewayHooks) (assistant.Gateway, func(), error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.servers, g.hooks = s, h
	g.opened++
	return assistant.Gateway{URL: "http://127.0.0.1:1/mcp", Token: "tok"}, func() { g.mu.Lock(); g.closed++; g.mu.Unlock() }, nil
}

type fakeToolServer struct {
	tools []assistant.Tool
	calls []string
	out   string
}

func (f *fakeToolServer) Tools() ([]assistant.Tool, error) { return f.tools, nil }
func (f *fakeToolServer) Call(n string, a json.RawMessage) (assistant.ToolResult, error) {
	f.calls = append(f.calls, n+string(a))
	return assistant.ToolResult{Text: f.out}, nil
}
func (f *fakeToolServer) Close() {}

type fakeConnector struct {
	srv     *fakeToolServer
	env     map[string]string
	headers map[string]string
}

func (c *fakeConnector) Connect(s assistant.MCPServer, env, headers map[string]string) (assistant.ToolServer, error) {
	c.env, c.headers = env, headers
	return c.srv, nil
}

type ah struct {
	*harness
	fk *deviceFakes
	ag *fakeAgent
	gw *fakeGateway
	mc *fakeConnector
}

func newAH(t *testing.T) *ah {
	t.Helper()
	h := newHarness(t).unlocked(t)
	x := &ah{harness: h, fk: &deviceFakes{}, gw: &fakeGateway{}, mc: &fakeConnector{srv: &fakeToolServer{}}}
	x.fk.install(h)
	x.ag = &fakeAgent{id: "fake", name: "Fake AI", status: assistant.Status{State: assistant.StateReady, Version: "1.0"},
		reply: `{"explanation":"all fine","commands":[{"cmd":"df -h","why":"disk"}]}`}
	h.app.Core.Agents = []Agent{x.ag}
	h.app.Core.ToolGateway = x.gw
	h.app.Core.MCP = x.mc
	return x
}

// session opens a local terminal that the assistant may use.
func (x *ah) session(t *testing.T) string {
	t.Helper()
	sid, err := x.open(LocalHostID, 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	x.rec.wait(t, "term:ready:"+sid)
	if err := x.app.Assistant.SetProviderEnabled("fake", true); err != nil {
		t.Fatal(err)
	}
	if err := x.app.Assistant.ConfirmShare(sid); err != nil {
		t.Fatal(err)
	}
	return sid
}

// print makes the terminal show text and waits until the assistant can see it.
func (x *ah) print(t *testing.T, text string) {
	t.Helper()
	x.fk.last().onData([]byte(text))
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for sid := range x.app.Session.sessions {
			if st, err := x.app.Session.screen(sid); err == nil && strings.Contains(string(st.raw), strings.TrimSpace(text)[:5]) {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the text never reached the screen buffer")
}

func (x *ah) ask(t *testing.T, sid, q string) (assistantEvent, string) {
	t.Helper()
	id, err := x.app.Assistant.Ask(sid, q, AskOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return x.finish(t, id), id
}

type assistantEvent struct {
	reply ReplyView
	err   map[string]any
}

func (x *ah) finish(t *testing.T, id string) assistantEvent {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if e, ok := x.rec.find("assistant:done:" + id); ok {
			return assistantEvent{reply: e.data.(ReplyView)}
		}
		if e, ok := x.rec.find("assistant:error:" + id); ok {
			return assistantEvent{err: e.data.(map[string]any)}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the request never finished")
	return assistantEvent{}
}

func TestProvidersMustBeReadyAndPassTheIsolationTestToBeEnabled(t *testing.T) {
	x := newAH(t)
	ps := x.app.Assistant.Providers()
	if len(ps) != 1 || ps[0].Enabled || ps[0].Status.State != assistant.StateReady {
		t.Fatalf("%+v", ps)
	}
	x.ag.verifyErr = errors.New("isolation self-test failed: the agent used a tool")
	if err := x.app.Assistant.SetProviderEnabled("fake", true); err == nil || !strings.Contains(err.Error(), "self-test") {
		t.Fatalf("a provider that fails the self-test must not be enabled: %v", err)
	}
	if x.app.Assistant.Providers()[0].Enabled {
		t.Fatal("enabled despite failing the test")
	}
	x.ag.verifyErr = nil
	x.ag.status = assistant.Status{State: assistant.StateNeedsSignIn, Hint: "fake login"}
	if err := x.app.Assistant.SetProviderEnabled("fake", true); err == nil || !strings.Contains(err.Error(), "fake login") {
		t.Fatalf("a provider that is not signed in must not be enabled: %v", err)
	}
	x.ag.status = assistant.Status{State: assistant.StateReady, Version: "1.0"}
	if err := x.app.Assistant.SetProviderEnabled("fake", true); err != nil {
		t.Fatal(err)
	}
	p := x.app.Assistant.Providers()[0]
	if !p.Enabled || !p.Default || x.ag.verifies != 2 {
		t.Fatalf("%+v verifies=%d", p, x.ag.verifies)
	}
	// the same version is not tested again
	_ = x.app.Assistant.SetProviderEnabled("fake", false)
	_ = x.app.Assistant.SetProviderEnabled("fake", true)
	if x.ag.verifies != 2 {
		t.Fatalf("verified again: %d", x.ag.verifies)
	}
	// a new version is
	x.ag.status.Version = "2.0"
	_ = x.app.Assistant.SetProviderEnabled("fake", false)
	_ = x.app.Assistant.SetProviderEnabled("fake", true)
	if x.ag.verifies != 3 {
		t.Fatalf("a new version must be verified again: %d", x.ag.verifies)
	}
}

func TestDisablingTheDefaultPicksAnotherEnabledProvider(t *testing.T) {
	x := newAH(t)
	second := &fakeAgent{id: "second", name: "Second", status: assistant.Status{State: assistant.StateReady, Version: "1"}}
	x.app.Core.Agents = []Agent{x.ag, second}
	_ = x.app.Assistant.SetProviderEnabled("fake", true)
	_ = x.app.Assistant.SetProviderEnabled("second", true)
	if err := x.app.Assistant.SetProviderEnabled("fake", false); err != nil {
		t.Fatal(err)
	}
	if x.app.Assistant.Settings().DefaultProvider != "second" {
		t.Fatalf("%+v", x.app.Assistant.Settings())
	}
	_ = x.app.Assistant.SetProviderEnabled("second", false)
	if x.app.Assistant.Settings().DefaultProvider != "" {
		t.Fatal("no provider left, so no default")
	}
}

func TestModelsComeFromTheProviderAndNothingIsInvented(t *testing.T) {
	x := newAH(t)
	x.ag.models = []assistant.Model{{ID: "m1", Name: "Model 1"}, {ID: "m2", Name: "Model 2"}}
	l, err := x.app.Assistant.Models("fake", false)
	if err != nil || len(l.Models) != 3 || l.Models[0].ID != "" || l.Models[1].ID != "m1" || !l.CanList {
		t.Fatalf("%v %+v", err, l)
	}
	// a custom id is remembered
	if err := x.app.Assistant.SetProviderModel("fake", "my-model-9"); err != nil {
		t.Fatal(err)
	}
	l, _ = x.app.Assistant.Models("fake", false)
	if len(l.Models) != 4 || l.Models[3].ID != "my-model-9" {
		t.Fatalf("%+v", l.Models)
	}
	// a listed id is not duplicated into the custom list
	_ = x.app.Assistant.SetProviderModel("fake", "m2")
	if l, _ = x.app.Assistant.Models("fake", false); len(l.Models) != 4 {
		t.Fatalf("%+v", l.Models)
	}
	// the list is cached; a failed refresh keeps it and says so
	x.ag.modelsErr = errors.New("offline")
	l, _ = x.app.Assistant.Models("fake", true)
	if len(l.Models) != 4 || !strings.Contains(l.Error, "offline") {
		t.Fatalf("%+v", l)
	}
	// a provider that cannot list: only Default (and customs)
	g := &fakeAgent{id: "nolist", name: "No list", status: assistant.Status{State: assistant.StateReady}}
	x.app.Core.Agents = []Agent{x.ag, g}
	l, _ = x.app.Assistant.Models("nolist", false)
	if len(l.Models) != 1 || l.CanList {
		t.Fatalf("nothing must be invented: %+v", l)
	}
	for _, bad := range []string{"-x", "a b", "--model=evil", strings.Repeat("a", 200)} {
		if err := x.app.Assistant.SetProviderModel("fake", bad); err == nil {
			t.Errorf("model id %q must be rejected (it could be taken as a flag)", bad)
		}
	}
}

func TestAskNeverSendsASecretAndShowsMasks(t *testing.T) {
	x := newAH(t)
	if _, err := x.app.Vault.AddPassword("db", "root", "correct-horse-battery"); err != nil {
		t.Fatal(err)
	}
	sid := x.session(t)
	x.print(t, "export DB_PASSWORD=hunter2hunter2\r\nlogin with correct-horse-battery please\r\nkey AKIAIOSFODNN7EXAMPLE\r\nservice failed: disk full\r\n")
	x.ag.reply = `{"explanation":"The password correct-horse-battery is wrong; DB_PASSWORD=hunter2hunter2","commands":[{"cmd":"mysql -p correct-horse-battery","why":"x"},{"cmd":"df -h","why":"disk"}]}`
	x.ag.chunks = []string{"The pass", "word correct-hor", "se-battery"}
	ev, id := x.ask(t, sid, "why does it fail? my password is correct-horse-battery")
	if ev.err != nil {
		t.Fatal(ev.err)
	}
	sent := wire(x.ag.requests()[0])
	for _, leak := range []string{"hunter2hunter2", "correct-horse-battery", "AKIAIOSFODNN7EXAMPLE"} {
		if strings.Contains(sent, leak) {
			t.Errorf("%s was sent to the agent:\n%s", leak, sent)
		}
	}
	if !strings.Contains(sent, "service failed: disk full") || !strings.Contains(sent, "*******") {
		t.Fatalf("the rest of the screen must still be there:\n%s", sent)
	}
	r := ev.reply
	if strings.Contains(r.Text, "correct-horse-battery") || strings.Contains(r.Text, "hunter2") {
		t.Fatalf("a secret in the answer must be masked: %q", r.Text)
	}
	if len(r.Commands) != 2 || !r.Commands[0].Blocked || strings.Contains(r.Commands[0].Cmd, "correct-horse") || r.Commands[1].Blocked || r.Commands[1].Risk != assistant.RiskLow {
		t.Fatalf("%+v", r.Commands)
	}
	if r.Redacted < 3 {
		t.Fatalf("redacted=%d", r.Redacted)
	}
	// streamed text is masked even when a secret is split over two chunks
	for _, e := range x.rec.events {
		if e.name == "assistant:chunk:"+id {
			if txt := e.data.(map[string]any)["text"].(string); strings.Contains(txt, "correct-horse-battery") {
				t.Fatalf("a streamed chunk leaked: %q", txt)
			}
		}
	}
	// what is kept as history is sanitized too
	x.ag.reply = `{"explanation":"ok"}`
	x.ask(t, sid, "and now?")
	if strings.Contains(wire(x.ag.requests()[1]), "correct-horse-battery") {
		t.Fatal("history leaked a secret")
	}
	if x.rec.count("assistant:done:"+id) != 1 {
		t.Fatal("expected one done event")
	}
}

func TestAskFailsClosedWhenRedactionIsBroken(t *testing.T) {
	x := newAH(t)
	sid := x.session(t)
	if err := os.WriteFile(filepath.Join(x.core.DataDir, "assistant.json"), []byte(`{"providers":{"fake":{"enabled":true}},"default_provider":"fake","lines":200,"patterns":["("]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	x.app.Assistant.mu.Lock()
	x.app.Assistant.loaded = false
	x.app.Assistant.mu.Unlock()
	if _, err := x.app.Assistant.Ask(sid, "hi", AskOptions{}); err == nil {
		t.Fatal("a broken guard must stop the request")
	}
	if len(x.ag.requests()) != 0 {
		t.Fatal("nothing may reach the agent when the guard fails")
	}
}

func TestPolicyOffAskAndProduction(t *testing.T) {
	x := newAH(t)
	_ = x.app.Assistant.SetProviderEnabled("fake", true)
	sid, _ := x.open(LocalHostID, 80, 24)
	x.rec.wait(t, "term:ready:"+sid)
	if _, err := x.app.Assistant.Ask(sid, "hi", AskOptions{}); !errors.Is(err, ErrConfirmShare) {
		t.Fatalf("policy ask must wait for the user: %v", err)
	}
	if err := x.app.Assistant.ConfirmShare(sid); err != nil {
		t.Fatal(err)
	}
	if _, err := x.app.Assistant.Ask(sid, "hi", AskOptions{}); err != nil {
		t.Fatal(err)
	}

	srv := startServer(t)
	host := x.sshHost(t, "prod-web", srv, "")
	host.Env = domain.EnvProd
	host, _ = x.core.Store.SaveHost(host)
	psid, _ := x.open(host.ID, 80, 24)
	x.trust(t, psid)
	x.rec.wait(t, "term:ready:"+psid)
	info, _ := x.app.Assistant.SessionInfo(psid)
	if info.Policy != "off" || !info.Production {
		t.Fatalf("a production host defaults to off: %+v", info)
	}
	if _, err := x.app.Assistant.Ask(psid, "hi", AskOptions{}); err == nil || !strings.Contains(err.Error(), "turned off") {
		t.Fatalf("%v", err)
	}
	if err := x.app.Assistant.SetHostPolicy(host.ID, "on"); err != nil {
		t.Fatal(err)
	}
	if info, _ = x.app.Assistant.SessionInfo(psid); info.Policy != "on" {
		t.Fatalf("%+v", info)
	}
	if _, err := x.app.Assistant.Ask(psid, "hi", AskOptions{}); err != nil {
		t.Fatal(err)
	}
	// but commands are never run by the assistant on production
	if err := x.app.Assistant.Run(psid, "df -h", ""); err == nil || !strings.Contains(err.Error(), "production") {
		t.Fatalf("Run must be disabled on production: %v", err)
	}
	if err := x.app.Assistant.Insert(psid, "df -h"); err != nil {
		t.Fatalf("Insert is allowed on production: %v", err)
	}
	if err := x.app.Assistant.SetHostPolicy(host.ID, "maybe"); err == nil {
		t.Fatal("an unknown policy must be rejected")
	}
}

func TestSwitchingProviderStartsANewConversation(t *testing.T) {
	x := newAH(t)
	second := &fakeAgent{id: "second", name: "Second", status: assistant.Status{State: assistant.StateReady, Version: "1"}, reply: "plain"}
	x.app.Core.Agents = []Agent{x.ag, second}
	sid := x.session(t)
	_ = x.app.Assistant.SetProviderEnabled("second", true)
	x.ask(t, sid, "first question about nginx")
	id, _ := x.app.Assistant.Ask(sid, "second question", AskOptions{})
	x.finish(t, id)
	if h := x.ag.requests()[1].History; len(h) != 2 {
		t.Fatalf("the same provider keeps history: %d", len(h))
	}
	id, err := x.app.Assistant.Ask(sid, "to the other", AskOptions{Provider: "second"})
	if err != nil {
		t.Fatal(err)
	}
	x.finish(t, id)
	if h := second.requests()[0].History; len(h) != 0 {
		t.Fatalf("another provider must not receive the history: %v", h)
	}
}

func TestTheUICanChooseTheRequestIdToListenBeforeItStarts(t *testing.T) {
	x := newAH(t)
	sid := x.session(t)
	id, err := x.app.Assistant.Ask(sid, "q", AskOptions{RequestID: "req-12345"})
	if err != nil || id != "req-12345" {
		t.Fatalf("%q %v", id, err)
	}
	x.finish(t, id)
	for _, bad := range []string{"a b", "x", "../../etc", strings.Repeat("a", 60)} {
		if _, err := x.app.Assistant.Ask(sid, "q", AskOptions{RequestID: bad}); err == nil {
			t.Errorf("request id %q must be rejected", bad)
		}
	}
}

func TestAskErrorsAreClassified(t *testing.T) {
	x := newAH(t)
	sid := x.session(t)
	x.ag.askErr = assistant.ErrNeedsSignIn
	ev, _ := x.ask(t, sid, "q")
	if ev.err["code"] != "needs_signin" {
		t.Fatalf("%v", ev.err)
	}
	x.ag.askErr = assistant.ErrToolUse
	ev, _ = x.ask(t, sid, "q")
	if ev.err["code"] != "tool_use" {
		t.Fatalf("%v", ev.err)
	}
	x.ag.askErr = errors.New("boom with password=hunter2hunter2")
	ev, _ = x.ask(t, sid, "q")
	if ev.err["code"] != "other" || strings.Contains(ev.err["message"].(string), "hunter2") {
		t.Fatalf("errors are masked too: %v", ev.err)
	}
	x.ag.askErr = nil
	if _, err := x.app.Assistant.Ask(sid, "  ", AskOptions{}); err == nil {
		t.Fatal("empty question")
	}
	x.app.Assistant.SetProviderEnabled("fake", false)
	if _, err := x.app.Assistant.Ask(sid, "q", AskOptions{}); err == nil || !strings.Contains(err.Error(), "Enable a provider") {
		t.Fatalf("%v", err)
	}
}

func TestPlainTextReplyHasNoRunnableCommands(t *testing.T) {
	x := newAH(t)
	sid := x.session(t)
	x.ag.reply = "Just run df -h"
	ev, _ := x.ask(t, sid, "q")
	if ev.reply.Text != "Just run df -h" || len(ev.reply.Commands) != 0 {
		t.Fatalf("%+v", ev.reply)
	}
}

func TestInsertDoesNotPressEnterAndRunNeedsTheTypedWordForRiskyCommands(t *testing.T) {
	x := newAH(t)
	sid := x.session(t)
	if err := x.app.Assistant.Insert(sid, "df -h"); err != nil {
		t.Fatal(err)
	}
	x.rec.waitOutput(t, sid, "echo:df -h")
	if strings.Contains(x.rec.output(sid), "echo:df -h\r") {
		t.Fatal("Insert must not press Enter")
	}
	if err := x.app.Assistant.Run(sid, "uptime", ""); err != nil {
		t.Fatal(err)
	}
	x.rec.waitOutput(t, sid, "echo:uptime\r")
	if err := x.app.Assistant.Run(sid, "sudo reboot", ""); err == nil || !strings.Contains(err.Error(), "type run") {
		t.Fatalf("%v", err)
	}
	if err := x.app.Assistant.Run(sid, "sudo reboot", "run"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"ls\nrm -rf x", "ls\r", "echo \x1b[2J", "", "curl -d ******* x", "export TOKEN=abc12345678"} {
		if err := x.app.Assistant.Insert(sid, bad); err == nil {
			t.Errorf("Insert(%q) must be refused", bad)
		}
		if err := x.app.Assistant.Run(sid, bad, "run"); err == nil {
			t.Errorf("Run(%q) must be refused", bad)
		}
	}
	cc, _ := x.app.Assistant.CheckCommand(sid, "cat .env")
	if len(cc.Warnings) == 0 {
		t.Fatalf("%+v", cc)
	}
	if e, _ := x.core.Activity.List(domain.ActivityFilter{Kinds: []string{domain.ActAssistant}}); len(e) < 2 {
		t.Fatalf("commands must be logged: %v", e)
	}
}

func TestSettingsValidatePatternsAndOnlyAdd(t *testing.T) {
	x := newAH(t)
	if _, err := x.app.Assistant.SaveSettings(AssistantSettings{Lines: 300, Patterns: []string{"("}}); err == nil {
		t.Fatal("a broken pattern must be rejected")
	}
	s, err := x.app.Assistant.SaveSettings(AssistantSettings{Lines: 5000, Patterns: []string{`EMP-\d+`}, AutoRun: true})
	if err != nil || s.Lines != 1000 || !s.AutoRun {
		t.Fatalf("%v %+v", err, s)
	}
	sid := x.session(t)
	x.print(t, "badge EMP-123456 here\r\n")
	x.ask(t, sid, "q")
	if strings.Contains(wire(x.ag.requests()[0]), "EMP-123456") {
		t.Fatal("a custom pattern must be applied")
	}
	if _, err := x.app.Assistant.SaveSettings(AssistantSettings{Lines: 200, DefaultProvider: "fake"}); err != nil {
		t.Fatal(err)
	}
	if _, err := x.app.Assistant.SaveSettings(AssistantSettings{Lines: 200, DefaultProvider: "nobody"}); err == nil {
		t.Fatal("the default must be an enabled provider")
	}
}

func TestPreviewIsExactlyWhatIsSent(t *testing.T) {
	x := newAH(t)
	sid := x.session(t)
	x.print(t, "TOKEN=abcdef123456 value\r\nhello world\r\n")
	pv, err := x.app.Assistant.Preview(sid, 0, "")
	if err != nil || strings.Contains(pv.Text, "abcdef123456") || !strings.Contains(pv.Text, "hello world") || pv.Redacted == 0 {
		t.Fatalf("%v %+v", err, pv)
	}
	x.ask(t, sid, "q")
	if got := x.ag.requests()[0].Context.String(); got != pv.Text {
		t.Fatalf("the preview must match what is sent:\n%q\n%q", pv.Text, got)
	}
	pv, _ = x.app.Assistant.Preview(sid, 0, "only this TOKEN=zzzz999999")
	if strings.Contains(pv.Text, "zzzz999999") || strings.Contains(pv.Text, "hello world") {
		t.Fatalf("a selection replaces the screen: %q", pv.Text)
	}
}
