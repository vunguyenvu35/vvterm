package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"time"
)

// The Settings window is a second native window. Wails v2 can only create one window per process, so it
// is a second VVTerm process that holds no data of its own: every read and write goes through this bridge
// to the main process, which owns the vault and the database. The bridge listens on loopback only, needs
// a random token that is stored in a 0600 file inside the data directory, and exposes an explicit
// allow-list of use case methods.

// bridgeFile is the connection file the Settings process reads.
const bridgeFile = "settings-ipc.json"

type bridgeInfo struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

type bridgeTarget struct {
	obj     any
	allowed map[string]bool
}

// Bridge serves the allow-listed use cases to the Settings process.
type Bridge struct {
	token    string
	targets  map[string]bridgeTarget
	onChange func(service string)
	focus    chan struct{}
	srv      *http.Server
	ln       net.Listener
	file     string
}

func allow(names ...string) map[string]bool {
	m := map[string]bool{}
	for _, n := range names {
		m[n] = true
	}
	return m
}

// NewBridge exposes what the Settings window needs: settings, vault security options and Git sync.
func NewBridge(a *App, onChange func(service string)) *Bridge {
	return &Bridge{
		onChange: onChange,
		focus:    make(chan struct{}, 1),
		targets: map[string]bridgeTarget{
			"SettingsService": {a.Settings, allow("Get", "Save")},
			"VaultService":    {a.Vault, allow("Status", "ChangePassword", "SetAutoLock", "EnableBiometric", "DisableBiometric", "ResetVault")},
			"SyncService":     {a.Sync, allow("Configure", "SyncNow", "JoinExisting", "Status")},
		},
	}
}

var errorType = reflect.TypeOf((*error)(nil)).Elem()

// Dispatch calls an allow-listed method with JSON arguments and returns its JSON result.
func (b *Bridge) Dispatch(service, method string, args []json.RawMessage) (json.RawMessage, error) {
	t, ok := b.targets[service]
	if !ok || !t.allowed[method] {
		return nil, fmt.Errorf("%s.%s is not available from the settings window", service, method)
	}
	m := reflect.ValueOf(t.obj).MethodByName(method)
	if !m.IsValid() {
		return nil, fmt.Errorf("%s.%s does not exist", service, method)
	}
	mt := m.Type()
	if mt.IsVariadic() || mt.NumIn() != len(args) {
		return nil, fmt.Errorf("%s.%s takes %d argument(s), got %d", service, method, mt.NumIn(), len(args))
	}
	in := make([]reflect.Value, len(args))
	for i, raw := range args {
		p := reflect.New(mt.In(i))
		if err := json.Unmarshal(raw, p.Interface()); err != nil {
			return nil, fmt.Errorf("%s.%s argument %d: %w", service, method, i+1, err)
		}
		in[i] = p.Elem()
	}
	out := m.Call(in)
	var result any
	for _, o := range out {
		if o.Type() == errorType {
			if !o.IsNil() {
				return nil, o.Interface().(error)
			}
			continue
		}
		result = o.Interface()
	}
	if b.onChange != nil && !(service == "SettingsService" && method == "Get") && method != "Status" {
		b.onChange(service)
	}
	if result == nil {
		return json.RawMessage("null"), nil
	}
	return json.Marshal(result)
}

// RequestFocus asks the open Settings window to come to the front.
func (b *Bridge) RequestFocus() {
	select {
	case b.focus <- struct{}{}:
	default:
	}
}

func (b *Bridge) authorised(r *http.Request) bool {
	got := r.Header.Get("Authorization")
	want := "Bearer " + b.token
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

type callRequest struct {
	Service string            `json:"service"`
	Method  string            `json:"method"`
	Args    []json.RawMessage `json:"args"`
}

type callResponse struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func (b *Bridge) handler() http.Handler {
	mux := http.NewServeMux()
	guard := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !b.authorised(r) {
				http.Error(w, "unauthorised", http.StatusUnauthorized)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/ping", guard(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	mux.HandleFunc("/call", guard(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var req callRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		res, err := b.Dispatch(req.Service, req.Method, req.Args)
		resp := callResponse{Result: res}
		if err != nil {
			resp = callResponse{Error: err.Error()}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	// long poll: answers true when the main window wants the Settings window in front
	mux.HandleFunc("/focus", guard(func(w http.ResponseWriter, r *http.Request) {
		got := false
		select {
		case <-b.focus:
			got = true
		case <-time.After(20 * time.Second):
		case <-r.Context().Done():
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"focus": got})
	}))
	return mux
}

// Start listens on a loopback port and writes the connection file into dir.
func (b *Bridge) Start(dir string) error {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	b.token = hex.EncodeToString(raw)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	b.ln = ln
	info, _ := json.Marshal(bridgeInfo{Port: ln.Addr().(*net.TCPAddr).Port, Token: b.token})
	b.file = filepath.Join(dir, bridgeFile)
	tmp := b.file + ".tmp"
	if err := os.WriteFile(tmp, info, 0o600); err != nil {
		ln.Close()
		return err
	}
	if err := os.Rename(tmp, b.file); err != nil {
		ln.Close()
		return err
	}
	b.srv = &http.Server{Handler: b.handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = b.srv.Serve(ln) }()
	return nil
}

// Close stops the server and removes the connection file.
func (b *Bridge) Close() {
	if b.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = b.srv.Shutdown(ctx)
		_ = b.srv.Close()
	}
	if b.file != "" {
		_ = os.Remove(b.file)
	}
}

// ---- client side (the Settings process) ----

// BridgeClient talks to the main process.
type BridgeClient struct {
	base  string
	token string
	hc    *http.Client
}

// ConnectBridge reads the connection file written by the main process.
func ConnectBridge(dir string) (*BridgeClient, error) {
	raw, err := os.ReadFile(filepath.Join(dir, bridgeFile))
	if err != nil {
		return nil, errors.New("VVTerm is not running: open Settings from the main window")
	}
	var info bridgeInfo
	if err := json.Unmarshal(raw, &info); err != nil || info.Port == 0 || info.Token == "" {
		return nil, errors.New("the settings connection file is invalid")
	}
	return &BridgeClient{base: fmt.Sprintf("http://127.0.0.1:%d", info.Port), token: info.Token, hc: &http.Client{Timeout: 5 * time.Minute}}, nil
}

func (c *BridgeClient) do(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.hc.Do(req)
}

// Call forwards one use case call; args is a JSON array and the result is JSON text.
func (c *BridgeClient) Call(service, method, argsJSON string) (string, error) {
	var args []json.RawMessage
	if argsJSON != "" {
		if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
			return "", fmt.Errorf("bad arguments: %w", err)
		}
	}
	body, _ := json.Marshal(callRequest{Service: service, Method: method, Args: args})
	resp, err := c.do(context.Background(), http.MethodPost, "/call", body)
	if err != nil {
		return "", errors.New("VVTerm is not running")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the main window refused the request (%s)", resp.Status)
	}
	var out callResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Error != "" {
		return "", errors.New(out.Error)
	}
	return string(out.Result), nil
}

// Ping reports whether the main process still answers.
func (c *BridgeClient) Ping() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	resp, err := c.do(ctx, http.MethodGet, "/ping", nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return errors.New(resp.Status)
	}
	return nil
}

// WaitFocus blocks until the main window asks for the Settings window to be raised (or ~20 s pass).
func (c *BridgeClient) WaitFocus(ctx context.Context) (bool, error) {
	resp, err := c.do(ctx, http.MethodGet, "/focus", nil)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	var out map[string]bool
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, err
	}
	return out["focus"], nil
}
