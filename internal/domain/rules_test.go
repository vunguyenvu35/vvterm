package domain

import "testing"

func TestNormalizeHostDefaultsAndRejects(t *testing.T) {
	h := Host{Hostname: "10.0.0.1"}
	if err := NormalizeHost(&h); err != nil || h.Label != "10.0.0.1" || h.Port != 22 || h.KeepaliveSec != 30 {
		t.Fatalf("%v %+v", err, h)
	}
	for name, bad := range map[string]Host{
		"empty":     {},
		"newline":   {Hostname: "a\nProxyCommand x"},
		"space":     {Hostname: "a b"},
		"user ctrl": {Hostname: "a", Username: "u\r"},
		"port":      {Hostname: "a", Port: 70000},
		"env":       {Hostname: "a", Env: "qa"},
	} {
		if err := NormalizeHost(&bad); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestNormalizeForwardSafeBindDefaults(t *testing.T) {
	f := PortForward{Type: ForwardDynamic}
	if err := NormalizeForward(&f); err != nil || f.BindAddr != "127.0.0.1" {
		t.Fatalf("%v %+v", err, f)
	}
	pub := PortForward{Type: ForwardDynamic, BindAddr: "0.0.0.0"}
	if NormalizeForward(&pub) == nil {
		t.Fatal("public bind accepted without opt-in")
	}
	pub.AllowPublicBind = true
	if err := NormalizeForward(&pub); err != nil {
		t.Fatal(err)
	}
	if NormalizeForward(&PortForward{Type: ForwardLocal}) == nil {
		t.Fatal("local forward without destination accepted")
	}
	if NormalizeForward(&PortForward{Type: "x"}) == nil {
		t.Fatal("unknown type accepted")
	}
}

func TestIsLoopback(t *testing.T) {
	for _, a := range []string{"127.0.0.1", "::1", "localhost", "LOCALHOST"} {
		if !IsLoopback(a) {
			t.Errorf("%s should be loopback", a)
		}
	}
	for _, a := range []string{"0.0.0.0", "192.168.1.1", "example.com", ""} {
		if IsLoopback(a) {
			t.Errorf("%s should not be loopback", a)
		}
	}
}

func TestCheckJumpChain(t *testing.T) {
	hosts := map[string]Host{
		"a": {Meta: Meta{ID: "a"}}, "b": {Meta: Meta{ID: "b"}, JumpHostID: "a"}, "c": {Meta: Meta{ID: "c"}, JumpHostID: "b"},
	}
	look := func(id string) (Host, bool) { h, ok := hosts[id]; return h, ok }
	if err := CheckJumpChain("d", "c", look); err != nil {
		t.Fatal(err)
	}
	if CheckJumpChain("a", "c", look) == nil {
		t.Fatal("loop accepted")
	}
	if CheckJumpChain("a", "a", look) == nil {
		t.Fatal("self jump accepted")
	}
	if CheckJumpChain("d", "zzz", look) == nil {
		t.Fatal("missing jump host accepted")
	}
}
