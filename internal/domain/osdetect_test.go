package domain

import (
	"strings"
	"testing"
)

func TestParseOS(t *testing.T) {
	const ubuntuRel = "PRETTY_NAME=\"Ubuntu 24.04.2 LTS\"\nNAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n"
	cases := []struct{ name, version, uname, release, want string }{
		{"ubuntu from os-release", "SSH-2.0-OpenSSH_9.6p1", "Linux\n", ubuntuRel, "ubuntu"},
		{"debian", "", "Linux", "ID=debian\n", "debian"},
		{"quoted id", "", "Linux", "ID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\n", "rocky"},
		{"centos", "", "Linux", "ID=\"centos\"\n", "centos"},
		{"amazon linux", "", "Linux", "ID=\"amzn\"\n", "amazon"},
		{"opensuse leap", "", "Linux", "ID=\"opensuse-leap\"\n", "suse"},
		{"alpine", "", "Linux", "ID=alpine\n", "alpine"},
		{"a derivative falls back to ID_LIKE", "", "Linux", "ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n", "ubuntu"},
		{"an unknown distro is plain linux", "", "Linux", "ID=weirdos\n", "linux"},
		{"macOS has no os-release", "SSH-2.0-OpenSSH_9.6", "Darwin\n", "", "macos"},
		{"freebsd by uname", "", "FreeBSD\n", "", "freebsd"},
		{"openbsd by uname", "", "OpenBSD", "", "openbsd"},
		{"windows git-bash", "", "MINGW64_NT-10.0-19045", "", "windows"},
		{"os-release beats uname and banner", "SSH-2.0-OpenSSH_9.6 Debian-5", "Linux", ubuntuRel, "ubuntu"},
		{"uname beats banner", "SSH-2.0-OpenSSH_9.6 Debian-5", "Darwin", "", "macos"},
		{"banner only: ubuntu", "SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13", "", "", "ubuntu"},
		{"banner only: raspbian before debian", "SSH-2.0-OpenSSH_9.2p1 Raspbian-2", "", "", "raspbian"},
		{"banner only: debian", "SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3", "", "", "debian"},
		{"banner only: freebsd", "SSH-2.0-OpenSSH_9.5 FreeBSD-20240318", "", "", "freebsd"},
		{"banner only: windows", "SSH-2.0-OpenSSH_for_Windows_9.5", "", "", "windows"},
		{"linux uname with no os-release", "SSH-2.0-dropbear", "Linux", "", "linux"},
		{"nothing known", "SSH-2.0-Go", "", "", ""},
		{"garbage", "", "command not found", "<html>", ""},
	}
	for _, c := range cases {
		got := ParseOS(c.version, c.uname, c.release)
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
		if got != "" && !KnownOS[got] {
			t.Errorf("%s: %q is not in KnownOS", c.name, got)
		}
	}
}

func TestNormalizeHostRejectsUnknownOS(t *testing.T) {
	h := Host{Hostname: "x", OS: "plan9"}
	if err := NormalizeHost(&h); err == nil {
		t.Fatal("an unknown os must be rejected")
	}
	h = Host{Hostname: "x", OS: "ubuntu"}
	if err := NormalizeHost(&h); err != nil {
		t.Fatal(err)
	}
}

func TestNormalizeForwardLabel(t *testing.T) {
	f := PortForward{Type: ForwardDynamic, Label: "  SOCKS to prod  "}
	if err := NormalizeForward(&f); err != nil || f.Label != "SOCKS to prod" {
		t.Fatalf("%q %v", f.Label, err)
	}
	for _, bad := range []string{"two\nlines", strings.Repeat("a", 81)} {
		f := PortForward{Type: ForwardDynamic, Label: bad}
		if err := NormalizeForward(&f); err == nil {
			t.Errorf("label %q must be rejected", bad)
		}
	}
	f = PortForward{Type: ForwardDynamic, Label: strings.Repeat("é", 80)}
	if err := NormalizeForward(&f); err != nil {
		t.Fatalf("80 characters are fine, even when each is two bytes: %v", err)
	}
}

func TestNormalizeHostTelnetAndTheme(t *testing.T) {
	h := Host{Hostname: "x", TelnetEnabled: true}
	if err := NormalizeHost(&h); err != nil || h.TelnetPort != 23 {
		t.Fatalf("Telnet defaults to port 23: %+v %v", h, err)
	}
	h = Host{Hostname: "x", TelnetEnabled: true, TelnetPort: 2323}
	if err := NormalizeHost(&h); err != nil || h.TelnetPort != 2323 {
		t.Fatalf("%+v %v", h, err)
	}
	h = Host{Hostname: "x", TelnetPort: 2323}
	if err := NormalizeHost(&h); err != nil || h.TelnetPort != 0 {
		t.Fatalf("a port without Telnet means nothing: %+v %v", h, err)
	}
	for _, bad := range []Host{
		{Hostname: "x", TelnetEnabled: true, TelnetPort: 70000},
		{Hostname: "x", TelnetEnabled: true, TelnetPort: -1},
		{Hostname: "x", TerminalTheme: "has space"},
		{Hostname: "x", TerminalTheme: "../etc"},
		{Hostname: "x", TerminalTheme: strings.Repeat("a", 41)},
	} {
		b := bad
		if err := NormalizeHost(&b); err == nil {
			t.Errorf("%+v must be rejected", bad)
		}
	}
	if err := NormalizeHost(&Host{Hostname: "x", AIPolicy: "sometimes"}); err == nil {
		t.Fatal("an unknown assistant policy must be rejected")
	}
	h = Host{Hostname: "x", TerminalTheme: "tokyo-night"}
	if err := NormalizeHost(&h); err != nil {
		t.Fatal(err)
	}
}
