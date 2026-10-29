//go:build windows

package localtty

func (s *Shell) killProcessGroup() {
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
}
