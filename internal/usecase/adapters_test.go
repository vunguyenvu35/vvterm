package usecase

import (
	"vvterm/internal/store"
	"vvterm/internal/vault"
)

// Compile-time proof that the real adapters satisfy the ports.
var (
	_ Repository  = (*store.Store)(nil)
	_ SecretVault = (*vault.Vault)(nil)
)
