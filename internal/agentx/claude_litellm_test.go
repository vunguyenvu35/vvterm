package agentx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func noEnv(string) string { return "" }

func TestClaudeModelsComeFromTheLiteLLMProxy(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		w.Write([]byte(`{"object":"list","data":[
			{"id":"gpt-4o","object":"model","owned_by":"openai"},
			{"id":"claude-sonnet-4-5","object":"model","owned_by":"openai"},
			{"id":"anthropic/*","object":"model"},
			{"id":"claude-opus-4-1","object":"model"},
			{"id":"claude-sonnet-4-5","object":"model"}]}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"env":{"ANTHROPIC_BASE_URL":"`+srv.URL+`/","ANTHROPIC_AUTH_TOKEN":"sk-litellm","DISABLE_TELEMETRY":1}}`), 0o600)

	c := &Claude{Bin: "/nonexistent", ConfigDir: dir, Getenv: noEnv}
	ms, err := c.Models(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/models" || gotAuth != "Bearer sk-litellm" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	var ids []string
	for _, m := range ms {
		ids = append(ids, m.ID)
	}
	if got := strings.Join(ids, ","); got != "claude-sonnet-4-5,claude-opus-4-1,gpt-4o" {
		t.Fatalf("ids = %s", got)
	}
}

func TestClaudeGatewayEnvWinsOverSettingsAndAPIKeyIsSent(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		w.Write([]byte(`{"data":[{"id":"claude-haiku-4-5","display_name":"Claude Haiku 4.5"}]}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1"}}`), 0o600)
	env := map[string]string{"ANTHROPIC_BASE_URL": srv.URL + "/v1", "ANTHROPIC_API_KEY": "sk-key"}
	ms, err := (&Claude{ConfigDir: dir, Getenv: func(k string) string { return env[k] }}).Models(context.Background())
	if err != nil || len(ms) != 1 || ms[0].Name != "Claude Haiku 4.5" || gotKey != "sk-key" {
		t.Fatalf("%v %+v key=%q", err, ms, gotKey)
	}
}

func TestClaudeGatewayErrorIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"Authentication Error"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	env := map[string]string{"ANTHROPIC_BASE_URL": srv.URL}
	_, err := (&Claude{ConfigDir: t.TempDir(), Getenv: func(k string) string { return env[k] }}).Models(context.Background())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err = %v", err)
	}
}
