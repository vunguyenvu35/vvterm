//go:build !windows

package localtty

import "syscall"

func (s *Shell) killProcessGroup() {
	if s.cmd.Process != nil {
		_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGHUP)
		_ = s.cmd.Process.Signal(syscall.SIGHUP)
	}
}
