package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"vvterm/internal/domain"
	"vvterm/internal/domain/assistant"
	"vvterm/internal/domain/secretpolicy"
	"vvterm/internal/fsutil"
)

// ErrConfirmShare is returned by Ask when the host's policy is "ask" and the user has not yet confirmed that
// the screen may be shared in this session. The UI shows the preview and calls ConfirmShare.
var ErrConfirmShare = errors.New("confirm_share")

const (
	maxQuestionRunes  = 4000
	maxSelectionRunes = 20000
	maxHistoryTurns   = 8
	modelsTTL         = 24 * time.Hour
	maxResultBytes    = 32 << 10
)

var modelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,99}$`)

// AssistantService is the AI terminal assistant. It never lets raw terminal text reach an agent: everything
// goes through secretpolicy.Guard first, and everything an agent says goes through it again before it is
// shown, stored or run. See docs/AIAssistant.md.
type AssistantService struct {
	c    *Core
	sess *SessionService

	mu        sync.Mutex
	cfg       assistant.Config
	loaded    bool
	detected  bool
	status    map[string]assistant.Status
	models    map[string]modelCache
	convs     map[string]*conversation
	confirmed map[string]bool
	runs      map[string]*assistRun
	mcpState  map[string]string
	seq       int
}

type modelCache struct {
	list []assistant.Model
	err  string
	at   time.Time
}

type conversation struct {
	provider string
	turns    []assistant.Turn
}

func NewAssistantService(c *Core, s *SessionService) *AssistantService {
	return &AssistantService{c: c, sess: s, status: map[string]assistant.Status{}, models: map[string]modelCache{},
		convs: map[string]*conversation{}, confirmed: map[string]bool{}, runs: map[string]*assistRun{}, mcpState: map[string]string{}}
}

// ---- configuration ----

func (a *AssistantService) file() string { return filepath.Join(a.c.DataDir, "assistant.json") }

func (a *AssistantService) cfgLocked() assistant.Config {
	if !a.loaded {
		b, _ := os.ReadFile(a.file())
		cfg, err := assistant.ParseConfig(b)
		if err != nil {
			cfg = assistant.DefaultConfig() // an unreadable file never blocks the app: everything stays off
		}
		a.cfg, a.loaded = cfg, true
	}
	return a.cfg
}

// config returns a snapshot. It is replaced, never edited in place, so callers may read it freely.
func (a *AssistantService) config() assistant.Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfgLocked()
}

// update edits a copy of the configuration and stores it.
func (a *AssistantService) update(fn func(c *assistant.Config) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	b, _ := json.Marshal(a.cfgLocked())
	var cp assistant.Config
	if err := json.Unmarshal(b, &cp); err != nil {
		return err
	}
	cp.Normalize()
	if err := fn(&cp); err != nil {
		return err
	}
	cp.Normalize()
	out, err := json.MarshalIndent(cp, "", "  ")
	if err != nil {
		return err
	}
	if err := fsutil.WriteFileAtomic(a.file(), out, 0o600); err != nil {
		return err
	}
	a.cfg = cp
	return nil
}

// AssistantSettings are the options of the Settings page that are not about one provider.
type AssistantSettings struct {
	Lines           int      `json:"lines"`
	Patterns        []string `json:"patterns"`
	AutoRun         bool     `json:"auto_run"`
	DefaultProvider string   `json:"default_provider"`
}

func (a *AssistantService) Settings() AssistantSettings {
	c := a.config()
	return AssistantSettings{Lines: c.Lines, Patterns: append([]string{}, c.Patterns...), AutoRun: c.AutoRun, DefaultProvider: c.DefaultProvider}
}

// SaveSettings validates and stores the options. Patterns can only add detectors.
func (a *AssistantService) SaveSettings(in AssistantSettings) (AssistantSettings, error) {
	var pats []string
	for _, p := range in.Patterns {
		if strings.TrimSpace(p) != "" {
			pats = append(pats, p)
		}
	}
	if _, err := (secretpolicy.Guard{}).WithPatterns(pats); err != nil {
		return AssistantSettings{}, err
	}
	err := a.update(func(c *assistant.Config) error {
		c.Lines, c.Patterns, c.AutoRun = in.Lines, pats, in.AutoRun
		if in.DefaultProvider != "" {
			if pc := c.Providers[in.DefaultProvider]; !pc.Enabled {
				return errors.New("the default provider must be enabled")
			}
			c.DefaultProvider = in.DefaultProvider
		}
		return nil
	})
	return a.Settings(), err
}

// ---- providers ----

type ProviderView struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Status      assistant.Status `json:"status"`
	Enabled     bool             `json:"enabled"`
	Default     bool             `json:"default"`
	Model       string           `json:"model"`
	SupportsMCP bool             `json:"supports_mcp"`
	Custom      bool             `json:"custom"`
}

func (a *AssistantService) agents() []Agent {
	list := append([]Agent{}, a.c.Agents...)
	if a.c.NewCustomAgent != nil {
		for _, cp := range a.config().Custom {
			list = append(list, a.c.NewCustomAgent(cp))
		}
	}
	return list
}

func (a *AssistantService) agent(id string) (Agent, bool) {
	for _, ag := range a.agents() {
		if ag.ID() == id {
			return ag, true
		}
	}
	return nil, false
}

func (a *AssistantService) detectOne(ag Agent) assistant.Status {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	st := ag.Detect(ctx)
	a.mu.Lock()
	a.status[ag.ID()] = st
	a.mu.Unlock()
	return st
}

func (a *AssistantService) detectAll() {
	var wg sync.WaitGroup
	for _, ag := range a.agents() {
		wg.Add(1)
		go func(ag Agent) { defer wg.Done(); a.detectOne(ag) }(ag)
	}
	wg.Wait()
	a.mu.Lock()
	a.detected = true
	a.mu.Unlock()
}

func (a *AssistantService) providerViews() []ProviderView {
	cfg := a.config()
	custom := map[string]bool{}
	for _, cp := range cfg.Custom {
		custom[cp.ID] = true
	}
	agents := a.agents() // before the lock: it reads the configuration
	a.mu.Lock()
	defer a.mu.Unlock()
	out := []ProviderView{}
	for _, ag := range agents {
		pc := cfg.Providers[ag.ID()]
		out = append(out, ProviderView{ID: ag.ID(), Name: ag.Name(), Status: a.status[ag.ID()], Enabled: pc.Enabled,
			Default: cfg.DefaultProvider == ag.ID(), Model: pc.Model, SupportsMCP: ag.SupportsMCP(), Custom: custom[ag.ID()]})
	}
	return out
}

// Providers lists the detected providers. The first call runs detection, which starts no prompt.
func (a *AssistantService) Providers() []ProviderView {
	a.mu.Lock()
	need := !a.detected
	a.mu.Unlock()
	if need {
		a.detectAll()
	}
	return a.providerViews()
}

// RefreshProviders runs detection again (the Refresh button).
func (a *AssistantService) RefreshProviders() []ProviderView {
	a.detectAll()
	return a.providerViews()
}

// SetProviderEnabled switches a provider on or off. Turning one on needs it to be ready and to pass the
// isolation self-test, which asks it to use a tool and must fail to do so.
func (a *AssistantService) SetProviderEnabled(id string, on bool) error {
	ag, ok := a.agent(id)
	if !ok {
		return errors.New("unknown provider")
	}
	if !on {
		return a.update(func(c *assistant.Config) error {
			pc := c.Providers[id]
			pc.Enabled = false
			c.Providers[id] = pc
			if c.DefaultProvider == id {
				c.DefaultProvider = ""
				for other, p := range c.Providers {
					if p.Enabled {
						c.DefaultProvider = other
						break
					}
				}
			}
			return nil
		})
	}
	st := a.detectOne(ag)
	if st.State != assistant.StateReady {
		msg := string(st.State)
		if st.Detail != "" {
			msg = st.Detail
		}
		if st.Hint != "" {
			msg += " (" + st.Hint + ")"
		}
		return fmt.Errorf("%s is not ready: %s", ag.Name(), msg)
	}
	if pc := a.config().Providers[id]; pc.VerifiedVersion == "" || pc.VerifiedVersion != st.Version {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := ag.Verify(ctx); err != nil {
			return fmt.Errorf("%s was not enabled: %w", ag.Name(), err)
		}
	}
	return a.update(func(c *assistant.Config) error {
		pc := c.Providers[id]
		pc.Enabled, pc.VerifiedVersion = true, st.Version
		c.Providers[id] = pc
		if c.DefaultProvider == "" {
			c.DefaultProvider = id
		}
		return nil
	})
}

// SetDefaultProvider chooses the provider the panel starts with.
func (a *AssistantService) SetDefaultProvider(id string) error {
	return a.update(func(c *assistant.Config) error {
		if !c.Providers[id].Enabled {
			return errors.New("enable the provider first")
		}
		c.DefaultProvider = id
		return nil
	})
}

// SetProviderModel stores a provider's default model ("" = the CLI decides). An id the provider did not list
// is kept as a custom model of that provider.
func (a *AssistantService) SetProviderModel(id, model string) error {
	model = strings.TrimSpace(model)
	if model != "" && !modelID.MatchString(model) {
		return errors.New("invalid model id")
	}
	if _, ok := a.agent(id); !ok {
		return errors.New("unknown provider")
	}
	listed := false // read before update: update holds the lock
	a.mu.Lock()
	for _, m := range a.models[id].list {
		listed = listed || m.ID == model
	}
	a.mu.Unlock()
	return a.update(func(c *assistant.Config) error {
		pc := c.Providers[id]
		pc.Model = model
		if model != "" {
			known := listed
			for _, m := range pc.CustomModels {
				known = known || m == model
			}
			if !known {
				pc.CustomModels = append([]string{model}, pc.CustomModels...)
				if len(pc.CustomModels) > 10 {
					pc.CustomModels = pc.CustomModels[:10]
				}
			}
		}
		c.Providers[id] = pc
		return nil
	})
}

// ModelList is what a provider offers. Default comes first and passes no model flag; the rest is read from
// the provider itself, then the custom ids the user used before. A provider that cannot list its models
// returns only the first and the custom ones: nothing is invented.
type ModelList struct {
	Models []assistant.Model `json:"models"`
	Error  string            `json:"error"`
	// CanList is false when the provider has no way to list models (a custom id is the only option).
	CanList bool `json:"can_list"`
}

// Models returns the model list of a provider, loading it from the provider when the cache is old.
func (a *AssistantService) Models(id string, refresh bool) (ModelList, error) {
	ag, ok := a.agent(id)
	if !ok {
		return ModelList{}, errors.New("unknown provider")
	}
	a.mu.Lock()
	mc, have := a.models[id]
	a.mu.Unlock()
	if !have || refresh || time.Since(mc.at) > modelsTTL {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		list, err := ag.Models(ctx)
		cancel()
		switch {
		case err != nil && have:
			mc.err = "Could not refresh models: " + err.Error() // keep the previous list
		case err != nil:
			mc = modelCache{err: err.Error(), at: time.Now()}
		default:
			mc = modelCache{list: list, at: time.Now()}
		}
		a.mu.Lock()
		a.models[id] = mc
		a.mu.Unlock()
	}
	out := ModelList{Error: mc.err, CanList: len(mc.list) > 0 || mc.err != ""}
	out.Models = append(out.Models, assistant.Model{ID: "", Name: "Default (CLI decides)"})
	seen := map[string]bool{"": true}
	for _, m := range mc.list {
		if !seen[m.ID] {
			seen[m.ID] = true
			out.Models = append(out.Models, m)
		}
	}
	for _, m := range a.config().Providers[id].CustomModels {
		if !seen[m] {
			seen[m] = true
			out.Models = append(out.Models, assistant.Model{ID: m, Name: m, Description: "custom model id"})
		}
	}
	return out, nil
}

// SaveCustomProvider adds or changes a user-defined provider. It stays off until it passes the self-test.
func (a *AssistantService) SaveCustomProvider(p assistant.CustomProvider) error {
	p.Name, p.Command = strings.TrimSpace(p.Name), strings.TrimSpace(p.Command)
	if p.Name == "" || p.Command == "" {
		return errors.New("name and command are required")
	}
	if p.PromptVia != "" && p.PromptVia != "stdin" && p.PromptVia != "arg" {
		return errors.New("prompt must be passed by stdin or arg")
	}
	if p.ID == "" {
		slug := regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(p.Name), "-")
		p.ID = "custom-" + strings.Trim(slug, "-")
	}
	if !strings.HasPrefix(p.ID, "custom-") {
		return errors.New("invalid provider id")
	}
	err := a.update(func(c *assistant.Config) error {
		for i, x := range c.Custom {
			if x.ID == p.ID {
				c.Custom[i] = p
				pc := c.Providers[p.ID] // a changed command must be verified again
				pc.Enabled, pc.VerifiedVersion = false, ""
				c.Providers[p.ID] = pc
				return nil
			}
		}
		c.Custom = append(c.Custom, p)
		return nil
	})
	if err == nil {
		a.detectAll()
	}
	return err
}

func (a *AssistantService) DeleteCustomProvider(id string) error {
	return a.update(func(c *assistant.Config) error {
		var keep []assistant.CustomProvider
		for _, x := range c.Custom {
			if x.ID != id {
				keep = append(keep, x)
			}
		}
		c.Custom = keep
		delete(c.Providers, id)
		if c.DefaultProvider == id {
			c.DefaultProvider = ""
		}
		return nil
	})
}

// ---- hosts and sessions ----

func (a *AssistantService) lookupHost(hostID string) (domain.Host, bool) {
	id := strings.TrimPrefix(hostID, telnetPrefix)
	if hostID == LocalHostID || strings.HasPrefix(hostID, serialPrefix) {
		return domain.Host{}, false
	}
	h, err := a.c.Store.GetHost(id)
	return h, err == nil
}

// SessionState tells the panel what it may do in one terminal.
type SessionState struct {
	HostID     string `json:"host_id"`
	Label      string `json:"label"`
	Policy     string `json:"policy"` // effective: off | ask | on
	Stored     string `json:"stored"` // what is saved on the host ("" = default)
	Production bool   `json:"production"`
	Confirmed  bool   `json:"confirmed"`
	Connected  bool   `json:"connected"`
}

func (a *AssistantService) SessionInfo(sid string) (SessionState, error) {
	st, err := a.sess.screen(sid)
	if err != nil {
		return SessionState{}, err
	}
	h, isHost := a.lookupHost(st.hostID)
	prod := isHost && h.Env == domain.EnvProd
	stored := ""
	if isHost {
		stored = h.AIPolicy
	}
	a.mu.Lock()
	conf := a.confirmed[sid]
	a.mu.Unlock()
	return SessionState{HostID: st.hostID, Label: a.c.hostLabel(st.hostID), Policy: string(assistant.EffectivePolicy(stored, prod)),
		Stored: stored, Production: prod, Confirmed: conf, Connected: st.state == "ready"}, nil
}

// SetHostPolicy stores the assistant switch of a host: "" (default), off, ask or on.
func (a *AssistantService) SetHostPolicy(hostID, policy string) error {
	if !assistant.ValidPolicy(policy) {
		return errors.New("policy must be off, ask or on")
	}
	h, err := a.c.Store.GetHost(hostID)
	if err != nil {
		return fmt.Errorf("host: %w", err)
	}
	h.AIPolicy = policy
	_, err = a.c.Store.SaveHost(h)
	return err
}

// ConfirmShare records that the user saw the preview and agreed to share this terminal in this session.
func (a *AssistantService) ConfirmShare(sid string) error {
	if _, err := a.sess.screen(sid); err != nil {
		return err
	}
	a.mu.Lock()
	a.confirmed[sid] = true
	a.mu.Unlock()
	return nil
}

// ForgetSession drops the conversation of a closed terminal.
func (a *AssistantService) ForgetSession(sid string) {
	a.mu.Lock()
	delete(a.convs, sid)
	delete(a.confirmed, sid)
	a.mu.Unlock()
}

// ResetConversation starts a new chat in a terminal.
func (a *AssistantService) ResetConversation(sid string) {
	a.mu.Lock()
	delete(a.convs, sid)
	a.mu.Unlock()
}

// ---- guard and context ----

func (a *AssistantService) guard() (secretpolicy.Guard, bool, error) {
	g := secretpolicy.Guard{}
	locked := true
	if a.c.Vault.Status().Unlocked {
		if secrets, err := a.c.Vault.DumpSecrets(); err == nil {
			vals := make([][]byte, 0, len(secrets))
			for _, s := range secrets {
				vals = append(vals, s.Value)
			}
			g = g.WithSecrets(vals)
			locked = false
		}
	}
	g, err := g.WithPatterns(a.config().Patterns)
	return g, locked, err
}

func (a *AssistantService) facts(hostID string) string {
	var b strings.Builder
	if h, ok := a.lookupHost(hostID); ok {
		fmt.Fprintf(&b, "Host: %s (%s)\n", h.Label, h.Hostname)
		if h.Username != "" {
			fmt.Fprintf(&b, "User: %s\n", h.Username)
		}
		if h.OS != "" {
			fmt.Fprintf(&b, "Operating system: %s\n", h.OS)
		}
		if h.Env != "" {
			fmt.Fprintf(&b, "Environment: %s\n", h.Env)
		}
	} else {
		fmt.Fprintf(&b, "Host: %s\n", a.c.hostLabel(hostID))
	}
	return b.String()
}

// PreviewView is exactly what would be sent as the terminal context, already redacted.
type PreviewView struct {
	Text        string                 `json:"text"`
	Findings    []secretpolicy.Finding `json:"findings"`
	Redacted    int                    `json:"redacted"`
	Lines       int                    `json:"lines"`
	AltScreen   bool                   `json:"alt_screen"`
	VaultLocked bool                   `json:"vault_locked"`
	Empty       bool                   `json:"empty"`
}

func (a *AssistantService) screenText(sid string, lines int, selection string) (text string, alt bool, hostID string, err error) {
	st, err := a.sess.screen(sid)
	if err != nil {
		return "", false, "", err
	}
	if selection != "" {
		if utf8.RuneCountInString(selection) > maxSelectionRunes {
			return "", false, "", errors.New("the selection is too long")
		}
		return selection, false, st.hostID, nil
	}
	if lines <= 0 {
		lines = a.config().Lines
	}
	if lines > 1000 {
		lines = 1000
	}
	text, alt = assistant.ScreenText(st.raw, lines)
	return text, alt, st.hostID, nil
}

// Preview shows what the assistant would receive. Nothing is sent.
func (a *AssistantService) Preview(sid string, lines int, selection string) (PreviewView, error) {
	raw, alt, hostID, err := a.screenText(sid, lines, selection)
	if err != nil {
		return PreviewView{}, err
	}
	g, locked, err := a.guard()
	if err != nil {
		return PreviewView{}, err
	}
	san, fs, err := g.Redact(a.facts(hostID) + "\n" + raw)
	if err != nil {
		return PreviewView{}, errors.New("Not sent: redaction failed")
	}
	if fs == nil {
		fs = []secretpolicy.Finding{}
	}
	return PreviewView{Text: san.String(), Findings: fs, Redacted: secretpolicy.Total(fs), Lines: strings.Count(raw, "\n") + 1,
		AltScreen: alt, VaultLocked: locked, Empty: strings.TrimSpace(raw) == ""}, nil
}
