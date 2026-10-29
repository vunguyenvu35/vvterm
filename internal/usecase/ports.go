package usecase

import (
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/sshx"
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
	// SetHostOS records the server type learned on a connection (icon) without touching other fields.
	SetHostOS(id, osName string) error
	DeleteHost(id string) error
	JumpChain(hostID string) ([]domain.Host, error)

	ListIdentities() []domain.Identity
	GetIdentity(id string) (domain.Identity, error)
	SaveIdentity(domain.Identity) (domain.Identity, error)
	DeleteIdentity(id string) error

	ListSnippets() []domain.Snippet
	SaveSnippet(domain.Snippet) (domain.Snippet, error)
	DeleteSnippet(id string) error

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
	Destroy() error
	ChangePassword(oldPW, newPW string) error
	SetAutoLock(d time.Duration)
	// Touch counts terminal activity as use, postponing the auto-lock; it never unlocks.
	Touch()
	SetHint(hint string) error
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

// RemoteFS is the port for remote file access (SFTP). Implemented by internal/sftpx. All remote
// paths are absolute; Upload and Download refuse to replace an existing target unless overwrite is set.
type RemoteFS interface {
	Home() (string, error)
	List(dir string) ([]domain.RemoteEntry, error)
	Mkdir(path string) error
	Rename(from, to string) error
	Chmod(path string, mode uint32) error
	Remove(path string, recursive bool) error
	Upload(local, remote string, overwrite bool, progress func(done, total int64)) error
	Download(remote, local string, overwrite bool, progress func(done, total int64)) error
	Close() error
}

// RemoteFSOpener starts a RemoteFS on an established SSH connection.
type RemoteFSOpener func(c *sshx.Client) (RemoteFS, error)

// Shell is a running terminal: an SSH shell, a shell on this computer, or a serial port. Output goes to the
// callback given when it was opened; keystrokes come in through Write.
type Shell interface {
	Write(p []byte) (int, error)
	Resize(cols, rows int) error
	// Done is closed when the terminal has ended; Err then says why (nil for a normal end).
	Done() <-chan struct{}
	Err() error
	Close()
}

// ShellOpener starts a shell on this computer.
type ShellOpener func(cols, rows int, onData func([]byte)) (Shell, error)

// SerialOpener opens a serial device at a baud rate.
type SerialOpener func(path string, baud int, onData func([]byte)) (Shell, error)

// TelnetOpener connects to host:port over Telnet and types the user name and password at the login prompt.
type TelnetOpener func(addr string, cols, rows int, user, pass string, onData func([]byte)) (Shell, error)

// SerialLister lists the serial ports this computer has.
type SerialLister func() ([]string, error)

// ActivityLog stores what happened (connections, transfers, forwards, unlocks) for the Logs page.
// Implemented by internal/sqlitedb.
type ActivityLog interface {
	Add(domain.ActivityEntry) error
	// List returns the newest lines first.
	List(domain.ActivityFilter) ([]domain.ActivityEntry, error)
	Clear() error
}
