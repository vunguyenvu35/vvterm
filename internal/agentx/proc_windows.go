//go:build windows

package agentx

import "os/exec"

func setProcAttr(cmd *exec.Cmd) {}
