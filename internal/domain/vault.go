package domain

// KDFParams are the Argon2id parameters stored in the vault header so they can be raised later.
type KDFParams struct {
	Salt    []byte `json:"salt"`
	Memory  uint32 `json:"m_kib"`
	Time    uint32 `json:"t"`
	Threads uint8  `json:"p"`
}

// VaultHeader is everything needed to unwrap the DEK with the master password.
type VaultHeader struct {
	Version    int       `json:"version"`
	KDF        KDFParams `json:"kdf"`
	WrappedDEK []byte    `json:"wrapped_dek"`
	Nonce      []byte    `json:"nonce"`
	// Hint is a reminder of the master password, kept in clear text so it can be shown while the vault is locked.
	Hint string `json:"hint,omitempty"`
}

// VaultStatus is the frontend-safe view of the vault.
type VaultStatus struct {
	Exists          bool `json:"exists"`
	Unlocked        bool `json:"unlocked"`
	KeychainEnabled bool `json:"keychain_enabled"`
	AutoLockMinutes int  `json:"auto_lock_minutes"`
	// Hint is the password reminder the user wrote (empty: none). BiometricAvailable: this Mac can ask for Touch ID.
	Hint               string `json:"hint,omitempty"`
	BiometricAvailable bool   `json:"biometric_available"`
}

// PlainSecret is a decrypted secret used only for encrypted backups.
type PlainSecret struct {
	ID    string     `json:"id"`
	Kind  SecretKind `json:"kind"`
	Value []byte     `json:"value"`
}
