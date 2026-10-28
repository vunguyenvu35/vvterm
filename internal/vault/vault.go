// Package vault implements envelope encryption: a random DEK encrypts every
// secret (AES-256-GCM, secret id as AAD) and the master password only wraps
// the DEK through Argon2id. Decrypted material never leaves this package
// except through GetSecret, which is used by Go-side services only.
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"

	"vvterm/internal/domain"
)

const (
	MinPasswordLen = 12
	fileVersion    = 1
	dekLen         = 32
	saltLen        = 16
)

var (
	ErrNoVault       = errors.New("vault does not exist")
	ErrExists        = errors.New("vault already exists")
	ErrLocked        = errors.New("vault is locked")
	ErrBadPassword   = errors.New("wrong master password")
	ErrWeakPassword  = fmt.Errorf("master password must be at least %d characters", MinPasswordLen)
	ErrSecretMissing = errors.New("secret not found")
	ErrNoKeychain    = errors.New("no DEK stored in keychain")
)

// DefaultKDF is the parameter set recommended by the architecture doc.
func DefaultKDF() KDFParams { return KDFParams{Memory: 64 * 1024, Time: 3, Threads: 4} }

// Snapshot is the complete persisted state of the vault.
type Snapshot struct {
	Header  Header          `json:"header"`
	Secrets []domain.Secret `json:"secrets"`
}

// Keychain abstracts the OS credential store used for quick unlock.
type Keychain interface {
	Set(service, user string, secret []byte) error
	Get(service, user string) ([]byte, error)
	Delete(service, user string) error
}

type Vault struct {
	mu       sync.Mutex
	p        Persister
	account  string
	kc       Keychain
	kdf      KDFParams // parameters used when creating/changing password
	f        *Snapshot
	dek      []byte
	autoLock time.Duration
	timer    *time.Timer
	onLock   func()
	// auth, when set, must succeed (Touch ID) before the keychain key is stored or used
	auth func(reason string) error
	now  func() time.Time
}

// New opens the vault stored as vault.json in dir (it may not exist yet). kc may be nil.
func New(dir string, kc Keychain) (*Vault, error) {
	return NewWith(JSONFile{Path: filepath.Join(dir, "vault.json")}, dir, kc)
}

// NewWith opens a vault on any Persister. account namespaces the keychain entry.
func NewWith(p Persister, account string, kc Keychain) (*Vault, error) {
	v := &Vault{p: p, account: account, kc: kc, kdf: DefaultKDF(),
		autoLock: 15 * time.Minute, now: func() time.Time { return time.Now().UTC() }}
	f, err := p.Load()
	if err != nil {
		return nil, err
	}
	v.f = f
	return v, nil
}

// SetKDF overrides the parameters used for new headers (tests use cheap ones).
func (v *Vault) SetKDF(p KDFParams) { v.kdf = p }

// OnLock registers a callback fired whenever the vault locks (manual or automatic).
func (v *Vault) OnLock(f func()) { v.onLock = f }

// SetAuthenticator makes Enable/UnlockKeychain ask the user first (Touch ID on a Mac). Without it the
// keychain key is used silently.
func (v *Vault) SetAuthenticator(f func(reason string) error) { v.auth = f }

func (v *Vault) Status() Status {
	v.mu.Lock()
	defer v.mu.Unlock()
	st := Status{Exists: v.f != nil, Unlocked: v.dek != nil, KeychainEnabled: v.keychainHas(),
		AutoLockMinutes: int(v.autoLock / time.Minute), BiometricAvailable: v.auth != nil && BiometricAvailable()}
	if v.f != nil {
		st.Hint = v.f.Header.Hint
	}
	return st
}

// MaxHintLen is the longest password hint.
const MaxHintLen = 120

// SetHint stores (or, empty, clears) the master password reminder. It is plain text on purpose: it must be
// readable while the vault is locked. The vault has to be unlocked, so only its owner can change it.
func (v *Vault) SetHint(hint string) error {
	hint = strings.TrimSpace(hint)
	if utf8.RuneCountInString(hint) > MaxHintLen {
		return fmt.Errorf("the hint can have at most %d characters", MaxHintLen)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f == nil {
		return ErrNoVault
	}
	if v.dek == nil {
		return ErrLocked
	}
	old := v.f.Header.Hint
	v.f.Header.Hint = hint
	if err := v.flush(); err != nil {
		v.f.Header.Hint = old
		return err
	}
	return nil
}

func (v *Vault) keychainHas() bool {
	if v.kc == nil || v.f == nil {
		return false
	}
	b, err := v.kc.Get("vvterm", v.account)
	return err == nil && len(b) == dekLen
}

// validKDF rejects parameters that would panic Argon2 or exhaust memory when they
// come from an untrusted file (sync repo, backup).
func validKDF(p KDFParams) error {
	if p.Time < 1 || p.Time > 64 || p.Threads < 1 || p.Memory < 8 || p.Memory > 2*1024*1024 || len(p.Salt) < 8 {
		return errors.New("invalid KDF parameters")
	}
	return nil
}

func deriveKEK(pw string, p KDFParams) []byte {
	return argon2.IDKey([]byte(pw), p.Salt, p.Time, p.Memory, p.Threads, dekLen)
}

func gcm(key []byte) (cipher.AEAD, error) {
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(blk)
}

func seal(key, plain, aad []byte) (ct, nonce []byte, err error) {
	g, err := gcm(key)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, g.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return g.Seal(nil, nonce, plain, aad), nonce, nil
}

func open(key, ct, nonce, aad []byte) ([]byte, error) {
	g, err := gcm(key)
	if err != nil {
		return nil, err
	}
	if len(nonce) != g.NonceSize() {
		return nil, errors.New("bad nonce length")
	}
	return g.Open(nil, nonce, ct, aad)
}

var headerAAD = []byte("vvterm/dek/v1")

func newHeader(pw string, p KDFParams, dek []byte) (Header, error) {
	p.Salt = make([]byte, saltLen)
	if _, err := rand.Read(p.Salt); err != nil {
		return Header{}, err
	}
	kek := deriveKEK(pw, p)
	defer zero(kek)
	ct, nonce, err := seal(kek, dek, headerAAD)
	if err != nil {
		return Header{}, err
	}
	return Header{Version: fileVersion, KDF: p, WrappedDEK: ct, Nonce: nonce}, nil
}

func unwrap(pw string, h Header) ([]byte, error) {
	if err := validKDF(h.KDF); err != nil {
		return nil, err
	}
	kek := deriveKEK(pw, h.KDF)
	defer zero(kek)
	dek, err := open(kek, h.WrappedDEK, h.Nonce, headerAAD)
	if err != nil {
		return nil, ErrBadPassword
	}
	return dek, nil
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func (v *Vault) flush() error { return v.p.Save(v.f) }

// Create initialises a new vault and leaves it unlocked.
func (v *Vault) Create(pw string) error {
	if utf8.RuneCountInString(pw) < MinPasswordLen {
		return ErrWeakPassword
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f != nil {
		return ErrExists
	}
	dek := make([]byte, dekLen)
	if _, err := rand.Read(dek); err != nil {
		return err
	}
	h, err := newHeader(pw, v.kdf, dek)
	if err != nil {
		return err
	}
	v.f = &Snapshot{Header: h, Secrets: []domain.Secret{}}
	if err := v.flush(); err != nil {
		v.f = nil
		return err
	}
	v.dek = dek
	v.armTimer()
	return nil
}

// Unlock derives the KEK from the master password and unwraps the DEK.
func (v *Vault) Unlock(pw string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f == nil {
		return ErrNoVault
	}
	if v.dek != nil {
		return nil
	}
	dek, err := unwrap(pw, v.f.Header)
	if err != nil {
		return err
	}
	v.dek = dek
	v.armTimer()
	return nil
}

// EnableKeychain stores the DEK in the OS keychain for quick unlock. Requires an unlocked vault.
func (v *Vault) EnableKeychain() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dek == nil {
		return ErrLocked
	}
	if v.kc == nil {
		return errors.New("keychain not available")
	}
	if v.auth != nil {
		if err := v.auth("turn on quick unlock for VVTerm"); err != nil {
			return err
		}
	}
	return v.kc.Set("vvterm", v.account, v.dek)
}

func (v *Vault) DisableKeychain() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.kc == nil {
		return nil
	}
	return v.kc.Delete("vvterm", v.account)
}

// UnlockKeychain unlocks with the DEK held by the OS keychain (Touch ID / system prompt on macOS).
func (v *Vault) UnlockKeychain() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f == nil {
		return ErrNoVault
	}
	if v.dek != nil {
		return nil
	}
	if v.kc == nil {
		return ErrNoKeychain
	}
	if v.auth != nil {
		if err := v.auth("unlock your saved keys and passwords"); err != nil {
			return err
		}
	}
	dek, err := v.kc.Get("vvterm", v.account)
	if err != nil || len(dek) != dekLen {
		return ErrNoKeychain
	}
	// verify the DEK really belongs to this vault before trusting it
	if err := v.verifyDEK(dek); err != nil {
		_ = v.kc.Delete("vvterm", v.account)
		return ErrNoKeychain
	}
	v.dek = dek
	v.armTimer()
	return nil
}

func (v *Vault) verifyDEK(dek []byte) error {
	for _, s := range v.f.Secrets {
		_, err := open(dek, s.Ciphertext, s.Nonce, []byte(s.ID))
		return err
	}
	return nil
}

// Lock wipes the DEK from memory.
func (v *Vault) Lock() {
	v.mu.Lock()
	was := v.dek != nil
	v.lockLocked()
	cb := v.onLock
	v.mu.Unlock()
	if was && cb != nil {
		cb()
	}
}

func (v *Vault) lockLocked() {
	zero(v.dek)
	v.dek = nil
	if v.timer != nil {
		v.timer.Stop()
		v.timer = nil
	}
}

// SetAutoLock sets the inactivity timeout; zero disables it.
func (v *Vault) SetAutoLock(d time.Duration) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.autoLock = d
	if v.dek != nil {
		v.armTimer()
	}
}

func (v *Vault) armTimer() {
	if v.timer != nil {
		v.timer.Stop()
		v.timer = nil
	}
	if v.autoLock <= 0 {
		return
	}
	var t *time.Timer
	t = time.AfterFunc(v.autoLock, func() {
		v.mu.Lock()
		if v.timer != t { // superseded by a later activity
			v.mu.Unlock()
			return
		}
		v.lockLocked()
		cb := v.onLock
		v.mu.Unlock()
		if cb != nil {
			cb()
		}
	})
	v.timer = t
}

// ChangePassword re-wraps the DEK; secrets are untouched.
func (v *Vault) ChangePassword(oldPW, newPW string) error {
	if utf8.RuneCountInString(newPW) < MinPasswordLen {
		return ErrWeakPassword
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f == nil {
		return ErrNoVault
	}
	dek, err := unwrap(oldPW, v.f.Header)
	if err != nil {
		return err
	}
	defer zero(dek)
	h, err := newHeader(newPW, v.kdf, dek)
	if err != nil {
		return err
	}
	old := v.f.Header
	h.Hint = old.Hint
	v.f.Header = h
	if err := v.flush(); err != nil {
		v.f.Header = old
		return err
	}
	return nil
}

// Destroy erases the vault for good: header, every secret and the keychain entry. It works while
// locked, because it is the way out when the master password is lost. Nothing can be recovered afterwards.
func (v *Vault) Destroy() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.lockLocked()
	if v.kc != nil {
		_ = v.kc.Delete("vvterm", v.account)
	}
	if err := v.p.Delete(); err != nil {
		return err
	}
	v.f = nil
	return nil
}

// ---- secrets ----

func (v *Vault) AddSecret(kind domain.SecretKind, plain []byte) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dek == nil {
		return "", ErrLocked
	}
	v.armTimer()
	id := domain.NewID()
	ct, nonce, err := seal(v.dek, plain, []byte(id))
	if err != nil {
		return "", err
	}
	v.f.Secrets = append(v.f.Secrets, domain.Secret{
		Meta: domain.Meta{ID: id, UpdatedAt: v.now()}, Kind: kind, Ciphertext: ct, Nonce: nonce})
	if err := v.flush(); err != nil {
		v.f.Secrets = v.f.Secrets[:len(v.f.Secrets)-1]
		return "", err
	}
	return id, nil
}

// GetSecret decrypts a secret. Internal use only: never expose through bindings.
func (v *Vault) GetSecret(id string) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dek == nil {
		return nil, ErrLocked
	}
	v.armTimer()
	for _, s := range v.f.Secrets {
		if s.ID == id && !s.Deleted() {
			return open(v.dek, s.Ciphertext, s.Nonce, []byte(s.ID))
		}
	}
	return nil, ErrSecretMissing
}

func (v *Vault) DeleteSecret(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f == nil {
		return ErrNoVault
	}
	for i := range v.f.Secrets {
		if v.f.Secrets[i].ID == id && !v.f.Secrets[i].Deleted() {
			now := v.now()
			v.f.Secrets[i].DeletedAt = &now
			v.f.Secrets[i].UpdatedAt = now
			v.f.Secrets[i].Ciphertext = nil
			v.f.Secrets[i].Nonce = nil
			return v.flush()
		}
	}
	return ErrSecretMissing
}

// ---- sync support ----

// Header returns the KDF/wrapped-DEK header (safe to publish).
func (v *Vault) Header() (Header, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f == nil {
		return Header{}, ErrNoVault
	}
	return v.f.Header, nil
}

// Secrets returns a copy of all secret records including tombstones.
func (v *Vault) Secrets() []domain.Secret {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f == nil {
		return nil
	}
	return append([]domain.Secret(nil), v.f.Secrets...)
}

// ReplaceSecrets overwrites the secret list (after a sync merge). The vault must be unlocked.
func (v *Vault) ReplaceSecrets(s []domain.Secret) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dek == nil {
		return ErrLocked
	}
	v.f.Secrets = append([]domain.Secret(nil), s...)
	return v.flush()
}

// Adopt installs a header and secrets that came from a sync repo on a machine without a vault.
// The master password must unwrap the header's DEK; the vault ends up unlocked.
func (v *Vault) Adopt(pw string, h Header, secrets []domain.Secret) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.f != nil {
		return ErrExists
	}
	dek, err := unwrap(pw, h)
	if err != nil {
		return err
	}
	v.f = &Snapshot{Header: h, Secrets: append([]domain.Secret(nil), secrets...)}
	if err := v.flush(); err != nil {
		v.f = nil
		return err
	}
	v.dek = dek
	v.armTimer()
	return nil
}

// SealBlob encrypts arbitrary data (the sync bundle) with the DEK.
func (v *Vault) SealBlob(plain, aad []byte) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dek == nil {
		return nil, ErrLocked
	}
	ct, nonce, err := seal(v.dek, plain, aad)
	if err != nil {
		return nil, err
	}
	return append(nonce, ct...), nil
}

// OpenBlob reverses SealBlob.
func (v *Vault) OpenBlob(blob, aad []byte) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dek == nil {
		return nil, ErrLocked
	}
	if len(blob) < 12 {
		return nil, errors.New("blob too short")
	}
	return open(v.dek, blob[12:], blob[:12], aad)
}

// SealWithPassword encrypts data with a key derived from an independent password
// (used by encrypted backups, which must not depend on the master password).
func SealWithPassword(pw string, plain []byte, p KDFParams) ([]byte, error) {
	if pw == "" {
		return nil, errors.New("password is required")
	}
	p.Salt = make([]byte, saltLen)
	if _, err := rand.Read(p.Salt); err != nil {
		return nil, err
	}
	key := deriveKEK(pw, p)
	defer zero(key)
	ct, nonce, err := seal(key, plain, []byte("vvterm/backup/v1"))
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Version    int       `json:"version"`
		KDF        KDFParams `json:"kdf"`
		Nonce      []byte    `json:"nonce"`
		Ciphertext []byte    `json:"ciphertext"`
	}{1, p, nonce, ct})
}

// OpenWithPassword reverses SealWithPassword.
func OpenWithPassword(pw string, blob []byte) ([]byte, error) {
	var e struct {
		Version    int       `json:"version"`
		KDF        KDFParams `json:"kdf"`
		Nonce      []byte    `json:"nonce"`
		Ciphertext []byte    `json:"ciphertext"`
	}
	if err := json.Unmarshal(blob, &e); err != nil || e.Version != 1 {
		return nil, errors.New("not a VVTerm backup file")
	}
	if err := validKDF(e.KDF); err != nil {
		return nil, err
	}
	key := deriveKEK(pw, e.KDF)
	defer zero(key)
	plain, err := open(key, e.Ciphertext, e.Nonce, []byte("vvterm/backup/v1"))
	if err != nil {
		return nil, ErrBadPassword
	}
	return plain, nil
}

// DumpSecrets decrypts every live secret (for encrypted backup export only).
func (v *Vault) DumpSecrets() ([]PlainSecret, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dek == nil {
		return nil, ErrLocked
	}
	out := []PlainSecret{}
	for _, s := range v.f.Secrets {
		if s.Deleted() {
			continue
		}
		p, err := open(v.dek, s.Ciphertext, s.Nonce, []byte(s.ID))
		if err != nil {
			return nil, fmt.Errorf("secret %s: %w", s.ID, err)
		}
		out = append(out, PlainSecret{ID: s.ID, Kind: s.Kind, Value: p})
	}
	return out, nil
}

// PutSecret inserts or replaces a secret under a fixed id (backup restore keeps
// Identity.SecretRef valid).
func (v *Vault) PutSecret(id string, kind domain.SecretKind, plain []byte) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.dek == nil {
		return ErrLocked
	}
	ct, nonce, err := seal(v.dek, plain, []byte(id))
	if err != nil {
		return err
	}
	rec := domain.Secret{Meta: domain.Meta{ID: id, UpdatedAt: v.now()}, Kind: kind, Ciphertext: ct, Nonce: nonce}
	for i := range v.f.Secrets {
		if v.f.Secrets[i].ID == id {
			v.f.Secrets[i] = rec
			return v.flush()
		}
	}
	v.f.Secrets = append(v.f.Secrets, rec)
	return v.flush()
}
