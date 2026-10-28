package domain

import (
	"bufio"
	"strings"
)

// KnownOS lists the values Host.OS may hold: what VVTerm can tell a server apart by (and draw an icon for).
// The empty string means "not detected yet".
var KnownOS = map[string]bool{
	"ubuntu": true, "debian": true, "raspbian": true, "kali": true, "centos": true, "rhel": true, "fedora": true,
	"rocky": true, "almalinux": true, "amazon": true, "suse": true, "alpine": true, "arch": true,
	"freebsd": true, "openbsd": true, "netbsd": true, "macos": true, "windows": true, "linux": true,
}

// osReleaseID maps /etc/os-release ID (and ID_LIKE words) to a KnownOS value.
var osReleaseID = map[string]string{
	"ubuntu": "ubuntu", "debian": "debian", "raspbian": "raspbian", "kali": "kali", "centos": "centos",
	"rhel": "rhel", "fedora": "fedora", "rocky": "rocky", "almalinux": "almalinux", "amzn": "amazon",
	"sles": "suse", "sled": "suse", "opensuse": "suse", "opensuse-leap": "suse", "opensuse-tumbleweed": "suse",
	"alpine": "alpine", "arch": "arch", "archarm": "arch", "manjaro": "arch",
}

// ParseOS works out the server type from what the first connection reveals: the SSH version string
// (free), the output of `uname -s` and the content of /etc/os-release (when the server lets us run a
// command). The most specific evidence wins; "" means it could not be told.
func ParseOS(serverVersion, uname, osRelease string) string {
	if id := fromOSRelease(osRelease); id != "" {
		return id
	}
	switch u := strings.ToLower(strings.TrimSpace(firstLine(uname))); {
	case u == "darwin":
		return "macos"
	case u == "freebsd":
		return "freebsd"
	case u == "openbsd":
		return "openbsd"
	case u == "netbsd":
		return "netbsd"
	case strings.HasPrefix(u, "mingw"), strings.HasPrefix(u, "msys"), strings.HasPrefix(u, "cygwin"), strings.Contains(u, "windows"):
		return "windows"
	}
	v := strings.ToLower(serverVersion)
	for _, w := range []string{"ubuntu", "raspbian", "debian", "freebsd", "netbsd", "openbsd"} {
		if strings.Contains(v, w) {
			return w
		}
	}
	if strings.Contains(v, "windows") {
		return "windows"
	}
	if strings.Contains(strings.ToLower(uname), "linux") {
		return "linux"
	}
	return ""
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func fromOSRelease(text string) string {
	var id, like string
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok {
			continue
		}
		v = strings.ToLower(strings.Trim(strings.TrimSpace(v), `"'`))
		switch k {
		case "ID":
			id = v
		case "ID_LIKE":
			like = v
		}
	}
	if m, ok := osReleaseID[id]; ok {
		return m
	}
	for _, w := range strings.Fields(like) { // a derivative: Linux Mint says "ubuntu debian"
		if m, ok := osReleaseID[w]; ok {
			return m
		}
	}
	if id != "" {
		return "linux"
	}
	return ""
}
