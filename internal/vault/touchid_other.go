//go:build !darwin && !windows

package vault

// BiometricAvailable is false off macOS and Windows: the OS keychain is used without a Touch ID prompt.
func BiometricAvailable() bool { return false }

// BiometricAuth always succeeds here (there is nothing to ask).
func BiometricAuth(string) error { return nil }
