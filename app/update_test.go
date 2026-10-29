package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		latest, current string
		want            bool
	}{
		{"v1.2.0", "1.1.0", true},
		{"1.10.0", "1.9.9", true},
		{"v1.1.0", "1.1.0", false},
		{"v1.0.9", "1.1.0", false},
		{"v1.2.0", "dev", false},
		{"nightly", "1.1.0", false},
		{"v2.0.0-beta", "1.9.0", true},
	} {
		if got := newerVersion(c.latest, c.current); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v", c.latest, c.current, got)
		}
	}
}

func TestCheckUpdate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/none" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"tag_name":"v1.3.0","html_url":"https://github.com/vunguyenvu35/vvterm/releases/tag/v1.3.0","body":"notes"}`))
	}))
	defer srv.Close()
	info, err := checkUpdate(context.Background(), srv.Client(), srv.URL+"/latest", "1.1.0")
	if err != nil || !info.Available || info.Latest != "1.3.0" || info.Notes != "notes" {
		t.Fatalf("%+v %v", info, err)
	}
	info, err = checkUpdate(context.Background(), srv.Client(), srv.URL+"/latest", "1.3.0")
	if err != nil || info.Available {
		t.Fatalf("%+v %v", info, err)
	}
	info, err = checkUpdate(context.Background(), srv.Client(), srv.URL+"/none", "1.1.0")
	if err != nil || info.Available {
		t.Fatalf("%+v %v", info, err)
	}
}
