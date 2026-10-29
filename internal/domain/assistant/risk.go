package assistant

import (
	"regexp"
	"strings"
)

// Risk is how dangerous a command looks. It is computed here; the agent's opinion is ignored.
type Risk string

const (
	RiskLow    Risk = "low"
	RiskMedium Risk = "medium"
	RiskHigh   Risk = "high"
)

var highRisk = []struct {
	re     *regexp.Regexp
	reason string
}{
	{regexp.MustCompile(`(^|[\s;&|])rm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+|--recursive|--force)`), "deletes files recursively or without asking"},
	{regexp.MustCompile(`(^|[\s;&|])dd\s`), "writes raw data to a device or file"},
	{regexp.MustCompile(`(^|[\s;&|])mkfs`), "formats a disk"},
	{regexp.MustCompile(`(^|[\s;&|])(chmod|chown)\s+(-[a-zA-Z]*R|--recursive)`), "changes permissions recursively"},
	{regexp.MustCompile(`>\s*/dev/(sd|nvme|hd|disk)`), "writes to a disk device"},
	{regexp.MustCompile(`:\(\)\s*\{`), "fork bomb"},
	{regexp.MustCompile(`(^|[\s;&|])(shutdown|reboot|halt|poweroff|init\s+[06])(\s|$)`), "stops or restarts the machine"},
	{regexp.MustCompile(`(curl|wget)[^|]*\|\s*(sudo\s+)?(ba|z)?sh`), "runs a downloaded script"},
	{regexp.MustCompile(`(^|[\s;&|])sudo(\s|$)`), "runs with administrator rights"},
	{regexp.MustCompile(`(^|[\s;&|])kill\s+-9|(^|[\s;&|])pkill|(^|[\s;&|])killall`), "kills processes"},
	{regexp.MustCompile(`(?i)drop\s+(database|table)|truncate\s+table`), "deletes database data"},
	{regexp.MustCompile(`iptables\s+-F|ufw\s+disable|nft\s+flush`), "removes firewall rules"},
}

var mediumRisk = regexp.MustCompile(`(^|[\s;&|])(rm|mv|cp|systemctl\s+(restart|stop|disable|enable|reload)|service\s+\S+\s+(restart|stop)|apt(-get)?\s+(install|remove|purge|upgrade)|yum\s+(install|remove)|dnf\s+(install|remove)|brew\s+(install|uninstall)|docker\s+(rm|stop|kill|restart|prune)|kubectl\s+(delete|apply|scale|rollout)|git\s+(reset|clean|push|checkout)|tee|truncate)(\s|$)|[^>]>[^>&]|>>`)

// harmlessRedirect is output sent nowhere or joined to the other stream: it writes no file.
var harmlessRedirect = regexp.MustCompile(`\d*>+\s*/dev/null|\d*>&\d`)

// Assess judges a command. Reasons are shown to the user.
func Assess(cmd string) (Risk, []string) {
	var reasons []string
	for _, h := range highRisk {
		if h.re.MatchString(cmd) {
			reasons = append(reasons, h.reason)
		}
	}
	if len(reasons) > 0 {
		return RiskHigh, reasons
	}
	if mediumRisk.MatchString(" " + harmlessRedirect.ReplaceAllString(cmd, " ")) {
		return RiskMedium, []string{"changes files, services or packages"}
	}
	return RiskLow, nil
}

var dumpers = []struct {
	re   *regexp.Regexp
	warn string
}{
	{regexp.MustCompile(`(^|[\s;&|])(env|printenv|export\s+-p|set)(\s*$|\s*[|;&])`), "prints environment variables, which often hold secrets"},
	{regexp.MustCompile(`(^|[\s;&|])history(\s|$)`), "prints shell history, which may contain secrets"},
	{regexp.MustCompile(`(cat|less|more|head|tail|bat|grep|cp|scp)\s+[^|;&]*(\.env|id_(rsa|ed25519|ecdsa|dsa)|\.pem|\.p12|\.pfx|\.netrc|\.pgpass|credentials|shadow|\.npmrc|\.git-credentials)`), "reads a file that usually holds secrets"},
	{regexp.MustCompile(`docker\s+inspect|kubectl\s+(get|describe)\s+secrets?|aws\s+configure\s+list|gcloud\s+auth\s+print`), "can print credentials"},
}

// DumpWarnings lists why a command may print secrets. The output is redacted before it returns to an agent,
// but the user should know.
func DumpWarnings(cmd string) []string {
	var out []string
	for _, d := range dumpers {
		if d.re.MatchString(cmd) {
			out = append(out, d.warn)
		}
	}
	return out
}

// SingleLine reports whether cmd is one line; a newline would run the command by itself when inserted.
func SingleLine(cmd string) bool { return !strings.ContainsAny(cmd, "\r\n") }

var (
	autoBase = map[string]bool{"ls": true, "df": true, "du": true, "uptime": true, "whoami": true, "hostname": true,
		"uname": true, "date": true, "free": true, "pwd": true, "id": true, "ps": true, "lsblk": true, "ip": true,
		"ss": true, "journalctl": true, "systemctl": true, "tail": true, "head": true, "wc": true, "stat": true}
	autoArg   = regexp.MustCompile(`^(-[A-Za-z0-9-]+|[A-Za-z0-9_./@:=,+-]+)$`)
	autoDeny  = regexp.MustCompile(`(?i)(\.env|id_|\.pem|shadow|secret|credential|token|passw|\.ssh|\.aws|\.kube|\.netrc|\.pgpass|\.npmrc|\.git-credentials|/proc/[0-9a-z]+/environ)`)
	autoShell = regexp.MustCompile("[;&|<>$`()\\\\{}*?!\"'~#\\n\\r]")
)

// ReadOnlyAllowed reports whether cmd is on the short allow-list of commands that only read: no shell
// syntax at all, a fixed set of programs, no follow or watch modes, nothing that looks like a secret path.
func ReadOnlyAllowed(cmd string) bool {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" || len(cmd) > 200 || autoShell.MatchString(cmd) || autoDeny.MatchString(cmd) {
		return false
	}
	f := strings.Fields(cmd)
	if !autoBase[f[0]] {
		return false
	}
	positional := 0
	for _, a := range f[1:] {
		if !autoArg.MatchString(a) {
			return false
		}
		if !strings.HasPrefix(a, "-") {
			positional++
		}
		switch {
		case a == "-f" || a == "--follow" || a == "-F" || a == "--watch" || a == "--set" || a == "--rotate" || a == "--flush",
			strings.HasPrefix(a, "--vacuum"):
			return false
		}
		if f[0] == "date" && a == "-s" {
			return false
		}
	}
	switch f[0] {
	case "date", "hostname", "uptime", "whoami", "free", "pwd", "uname":
		return positional == 0 // "hostname x" would rename the machine
	case "tail", "head", "wc", "stat":
		last := f[len(f)-1] // a file is needed: without one they wait on stdin forever
		return len(f) > 1 && (strings.HasPrefix(last, "/") || strings.HasPrefix(last, "./"))
	case "systemctl": // only "status" and "is-active"
		return len(f) >= 3 && (f[1] == "status" || f[1] == "is-active")
	case "ip":
		if len(f) == 3 && f[2] != "show" && f[2] != "list" {
			return false // "ip link set ..." changes the network
		}
		return len(f) >= 2 && len(f) <= 3 && (f[1] == "a" || f[1] == "addr" || f[1] == "r" || f[1] == "route" || f[1] == "link")
	}
	return true
}
