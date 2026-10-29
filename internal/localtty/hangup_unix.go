//go:build !windows

package localtty

import (
	"os"
	"syscall"
)

// hangup tells the process group (the shell and what it started) that the terminal is gone.
func hangup(p *os.Process) {
	_ = syscall.Kill(-p.Pid, syscall.SIGHUP)
	_ = p.Signal(syscall.SIGHUP)
}
