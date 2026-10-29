//go:build !windows

package agentx

import (
	"os/exec"
	"syscall"
)

// setProcAttr puts the agent in its own process group, so cancelling kills what it started too.
func setProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
}
