// Package domain holds the plain data types shared by all VVTerm packages.
// None of these types ever contain decrypted secrets.
package domain

import (
	"time"

	"github.com/google/uuid"
)

type Env string

const (
	EnvDev     Env = "dev"
	EnvStaging Env = "staging"
	EnvProd    Env = "prod"
)

type AuthType string

const (
	AuthKey      AuthType = "key"
	AuthPassword AuthType = "password"
	AuthAgent    AuthType = "agent"
)

type ForwardType string

const (
	ForwardLocal   ForwardType = "local"
	ForwardRemote  ForwardType = "remote"
	ForwardDynamic ForwardType = "dynamic"
)

type SecretKind string

const (
	SecretPrivateKey SecretKind = "private_key"
	SecretPassword   SecretKind = "password"
	SecretPassphrase SecretKind = "passphrase"
)

// Meta is embedded in every synced record: UUID v7 id, last update time and a
// tombstone marker so deletes propagate between machines.
type Meta struct {
	ID        string     `json:"id"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
}

func (m Meta) Deleted() bool { return m.DeletedAt != nil }

// NewID returns a UUID v7 string.
func NewID() string {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.NewString()
	}
	return id.String()
}

type Group struct {
	Meta
	Name      string `json:"name"`
	ParentID  string `json:"parent_id,omitempty"`
	Color     string `json:"color,omitempty"`
	SortOrder int    `json:"sort_order"`
}

type Host struct {
	Meta
	Label        string    `json:"label"`
	GroupID      string    `json:"group_id,omitempty"`
	Hostname     string    `json:"hostname"`
	Port         int       `json:"port"`
	Username     string    `json:"username"`
	IdentityID   string    `json:"identity_id,omitempty"`
	JumpHostID   string    `json:"jump_host_id,omitempty"`
	Env          Env       `json:"env,omitempty"`
	Tags         []string  `json:"tags,omitempty"`
	KeepaliveSec int       `json:"keepalive_sec"`
	CreatedAt    time.Time `json:"created_at"`
	// OS is the server type learned on the first connection (see ParseOS); it picks the host's icon.
	OS string `json:"os,omitempty"`
	// Telnet: the host can also be reached with Telnet on TelnetPort (unencrypted: opt in per host).
	TelnetEnabled bool `json:"telnet_enabled,omitempty"`
	TelnetPort    int  `json:"telnet_port,omitempty"`
	// TelnetUsername is typed at the Telnet login prompt (empty: the host's user name). The password is in the
	// vault (see TelnetSecretRef). TelnetEncoding is "" or "utf-8" (the default), or "iso-8859-1".
	TelnetUsername string `json:"telnet_username,omitempty"`
	TelnetEncoding string `json:"telnet_encoding,omitempty"`
	// TerminalTheme is this host's own colour theme (an id from the UI catalogue); empty follows Settings.
	TerminalTheme string `json:"terminal_theme,omitempty"`
}

type PortForward struct {
	Meta
	Label     string      `json:"label,omitempty"`
	HostID    string      `json:"host_id"`
	Type      ForwardType `json:"type"`
	BindAddr  string      `json:"bind_addr"`
	BindPort  int         `json:"bind_port"`
	DestHost  string      `json:"dest_host,omitempty"`
	DestPort  int         `json:"dest_port,omitempty"`
	AutoStart bool        `json:"auto_start"`
	// AllowPublicBind must be set explicitly to bind anything but loopback.
	AllowPublicBind bool `json:"allow_public_bind,omitempty"`
}

// Identity is metadata only; the secret lives in the vault under SecretRef.
type Identity struct {
	Meta
	Name      string   `json:"name"`
	Username  string   `json:"username,omitempty"`
	AuthType  AuthType `json:"auth_type"`
	SecretRef string   `json:"secret_ref,omitempty"`
	PublicKey string   `json:"public_key,omitempty"`
	// Certificate is an OpenSSH user certificate for the key (public, not a secret): the server trusts the
	// authority that signed it instead of listing the key.
	Certificate string `json:"certificate,omitempty"`
}

// Secret is an encrypted record stored in vault.json.
type Secret struct {
	Meta
	Kind       SecretKind `json:"kind"`
	Ciphertext []byte     `json:"ciphertext"`
	Nonce      []byte     `json:"nonce"`
}

// HostFilter narrows ListHosts. Empty fields match everything.
type HostFilter struct {
	Query   string `json:"query"`
	GroupID string `json:"group_id"`
	Env     Env    `json:"env"`
	Tag     string `json:"tag"`
}

// Data is the content of hosts.json.
type Data struct {
	Version    int           `json:"version"`
	Groups     []Group       `json:"groups"`
	Hosts      []Host        `json:"hosts"`
	Forwards   []PortForward `json:"forwards"`
	Identities []Identity    `json:"identities"`
	Snippets   []Snippet     `json:"snippets"`
}

// Snippet is a reusable shell script. It is plain text (not a secret) and syncs with the other records.
type Snippet struct {
	Meta
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Script      string `json:"script"`
}

// RemoteEntry is one item of a remote directory listing (SFTP).
type RemoteEntry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"` // e.g. "drwxr-xr-x"
	ModTime time.Time `json:"mod_time"`
	IsDir   bool      `json:"is_dir"`
	IsLink  bool      `json:"is_link"`
}

// ActivityEntry is one line of the activity log: something that happened that the user may want to look up
// later (a connection, a transfer, a forward, an unlock). It never contains a secret.
type ActivityEntry struct {
	ID        int64     `json:"id"`
	At        time.Time `json:"at"`
	Kind      string    `json:"kind"`
	HostID    string    `json:"host_id,omitempty"`
	HostLabel string    `json:"host_label,omitempty"`
	Message   string    `json:"message"`
	OK        bool      `json:"ok"`
}

// Activity kinds.
const (
	ActConnect    = "connect"
	ActDisconnect = "disconnect"
	ActHostKey    = "hostkey"
	ActForward    = "forward"
	ActSFTP       = "sftp"
	ActTransfer   = "transfer"
	ActVault      = "vault"
	ActSync       = "sync"
)

// ActivityFilter narrows the log. Empty fields match everything.
type ActivityFilter struct {
	Kinds []string `json:"kinds"`
	Query string   `json:"query"`
	Limit int      `json:"limit"`
}

// TelnetSecretRef is where the vault keeps the Telnet password of a host.
func TelnetSecretRef(hostID string) string { return "telnet:" + hostID }
