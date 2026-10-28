package usecase

import (
	"time"

	"vvterm/internal/domain"
)

// Emitter delivers an event to the frontend. The delivery layer (Wails) supplies it.
type Emitter func(event string, data ...any)

// Repository is the persistence port for non-secret configuration. Implemented by
// internal/store (JSON files); a test double or another backend can replace it.
type Repository interface {
	Snapshot() domain.Data
	Replace(domain.Data) error

	ListGroups() []domain.Group
	SaveGroup(domain.Group) (domain.Group, error)
	DeleteGroup(id string) error

	ListHosts(domain.HostFilter) []domain.Host
	GetHost(id string) (domain.Host, error)
	SaveHost(domain.Host) (domain.Host, error)
	DeleteHost(id string) error
	JumpChain(hostID string) ([]domain.Host, error)

	ListIdentities() []domain.Identity
	GetIdentity(id string) (domain.Identity, error)
	SaveIdentity(domain.Identity) (domain.Identity, error)
	DeleteIdentity(id string) error

	ListForwards(hostID string) []domain.PortForward
	GetForward(id string) (domain.PortForward, error)
	SaveForward(domain.PortForward) (domain.PortForward, error)
	DeleteForward(id string) error
}

// SecretVault is the port for encrypted secret storage. Implemented by internal/vault.
// Decrypted material is only reachable through GetSecret/DumpSecrets, which use cases must
// never return to the frontend.
type SecretVault interface {
	Status() domain.VaultStatus
	Create(masterPassword string) error
	Unlock(masterPassword string) error
	UnlockKeychain() error
	EnableKeychain() error
	DisableKeychain() error
	Lock()
	ChangePassword(oldPW, newPW string) error
	SetAutoLock(d time.Duration)
	OnLock(func())

	AddSecret(kind domain.SecretKind, plain []byte) (string, error)
	GetSecret(id string) ([]byte, error)
	PutSecret(id string, kind domain.SecretKind, plain []byte) error
	DeleteSecret(id string) error
	DumpSecrets() ([]domain.PlainSecret, error)

	// sync support
	Header() (domain.VaultHeader, error)
	Secrets() []domain.Secret
	ReplaceSecrets([]domain.Secret) error
	Adopt(masterPassword string, h domain.VaultHeader, secrets []domain.Secret) error
	SealBlob(plain, aad []byte) ([]byte, error)
	OpenBlob(blob, aad []byte) ([]byte, error)
}
