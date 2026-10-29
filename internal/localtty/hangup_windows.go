//go:build windows

package localtty

import "os"

// hangup stops the process: Windows has no process groups to signal.
func hangup(p *os.Process) { _ = p.Kill() }
