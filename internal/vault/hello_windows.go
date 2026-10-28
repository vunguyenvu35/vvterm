//go:build windows

package vault

import (
	"bytes"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Windows Hello (fingerprint, face or PIN) through the WinRT UserConsentVerifier. It is called from Windows
// PowerShell, which can reach WinRT without cgo; the window is hidden so only the Hello sheet shows.
// NOTE: written without a Windows machine at hand, so it still needs testing on one.

const helloPrelude = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1' })[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$t.Wait(-1)
  $t.Result
}
`

const helloAvailable = helloPrelude + `
Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
`

const helloVerify = helloPrelude + `
Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($env:VVTERM_HELLO_MESSAGE)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
`

func runPowerShell(script, message string, timeout time.Duration) (string, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(cmd.Environ(), "VVTERM_HELLO_MESSAGE="+message)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Start(); err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return "", errors.New(strings.TrimSpace(errb.String()))
		}
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		return "", errors.New("Windows Hello did not answer")
	}
	return strings.TrimSpace(out.String()), nil
}

var (
	helloOnce  sync.Once
	helloReady bool
)

// BiometricAvailable reports whether Windows Hello is set up for this user. The answer is kept: asking
// starts PowerShell, and the vault status is read often.
func BiometricAvailable() bool {
	helloOnce.Do(func() {
		got, err := runPowerShell(helloAvailable, "", 15*time.Second)
		helloReady = err == nil && got == "Available"
	})
	return helloReady
}

// BiometricAuth shows the Windows Hello sheet; reason is the line it displays.
func BiometricAuth(reason string) error {
	if reason != "" {
		reason = strings.ToUpper(reason[:1]) + reason[1:]
	}
	got, err := runPowerShell(helloVerify, reason, 2*time.Minute)
	if err != nil {
		return err
	}
	switch got {
	case "Verified":
		return nil
	case "Canceled":
		return errors.New("authentication cancelled")
	case "RetriesExhausted":
		return errors.New("too many failed attempts")
	case "NotConfiguredForUser", "DeviceNotPresent":
		return errors.New("Windows Hello is not set up on this PC")
	case "DisabledByPolicy":
		return errors.New("Windows Hello is turned off by policy")
	case "DeviceBusy":
		return errors.New("Windows Hello is busy, try again")
	}
	return errors.New("Windows Hello: " + got)
}
