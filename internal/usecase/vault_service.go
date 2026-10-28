package usecase

import (
	"crypto/ed25519"
	"crypto/rsa"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/domain"
	"vvterm/internal/vault"
)

// VaultService exposes vault operations. No method returns a secret to the frontend.
type VaultService struct{ c *Core }

func NewVaultService(c *Core) *VaultService { return &VaultService{c} }

func (s *VaultService) Status() vault.Status { return s.c.Vault.Status() }

func (s *VaultService) Create(pw string) error { return s.c.Vault.Create(pw) }

func (s *VaultService) Unlock(pw string) error { return s.c.Vault.Unlock(pw) }

// UnlockBiometric unlocks with the DEK stored in the OS keychain.
func (s *VaultService) UnlockBiometric() error { return s.c.Vault.UnlockKeychain() }

func (s *VaultService) EnableBiometric() error { return s.c.Vault.EnableKeychain() }

func (s *VaultService) DisableBiometric() error { return s.c.Vault.DisableKeychain() }

func (s *VaultService) Lock() { s.c.Vault.Lock() }

// ResetConfirmation is the text the user must type to reset the vault.
const ResetConfirmation = "RESET"

// ResetVault is the way out when the master password is lost. The vault is zero-knowledge, so the
// password cannot be recovered: this erases the vault and every key/password identity, and keeps the
// rest (hosts, groups, snippets, forwards, ssh-agent identities). Hosts that used an erased identity
// lose that reference and need new credentials. It works while the vault is locked. If an encrypted
// backup exists it can be restored into the new vault afterwards.
func (s *VaultService) ResetVault(confirm string) error {
	if strings.TrimSpace(confirm) != ResetConfirmation {
		return fmt.Errorf("type %s to confirm", ResetConfirmation)
	}
	erased := map[string]bool{}
	for _, id := range s.c.Store.ListIdentities() {
		if id.AuthType == domain.AuthAgent {
			continue // no secret stored: keep
		}
		erased[id.ID] = true
	}
	for _, h := range s.c.Store.ListHosts(domain.HostFilter{}) {
		if erased[h.IdentityID] {
			h.IdentityID = ""
			if _, err := s.c.Store.SaveHost(h); err != nil {
				return err
			}
		}
	}
	for id := range erased {
		if err := s.c.Store.DeleteIdentity(id); err != nil {
			return err
		}
	}
	return s.c.Vault.Destroy()
}

func (s *VaultService) ChangePassword(oldPW, newPW string) error {
	return s.c.Vault.ChangePassword(oldPW, newPW)
}

// SetAutoLock sets the inactivity timeout in minutes (0 disables it).
func (s *VaultService) SetAutoLock(minutes int) error {
	if minutes < 0 || minutes > 24*60 {
		return errors.New("auto-lock must be between 0 and 1440 minutes")
	}
	s.c.setMu.Lock()
	s.c.settings.AutoLockMinutes = minutes
	err := s.c.saveSettings()
	s.c.setMu.Unlock()
	s.c.Vault.SetAutoLock(time.Duration(minutes) * time.Minute)
	return err
}

func (s *VaultService) ListIdentities() []domain.Identity { return s.c.Store.ListIdentities() }

// AddKey imports a private key file. An encrypted key needs its passphrase; the key is
// stored decrypted inside the (encrypted) vault so no passphrase prompt is needed later.
func (s *VaultService) AddKey(name, path, passphrase string) (domain.Identity, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return domain.Identity{}, err
	}
	return s.AddKeyPEM(name, string(b), passphrase)
}

// AddKeyPEM imports a pasted private key.
func (s *VaultService) AddKeyPEM(name, pemText, passphrase string) (domain.Identity, error) {
	return s.c.importKey(name, []byte(pemText), []byte(passphrase))
}

func (c *Core) importKey(name string, pemBytes, passphrase []byte) (domain.Identity, error) {
	if !c.Vault.Status().Unlocked {
		return domain.Identity{}, errNotUnlocked
	}
	if strings.TrimSpace(name) == "" {
		return domain.Identity{}, errors.New("identity name is required")
	}
	signer, err := vault.ParsePrivateKey(pemBytes, passphrase)
	if err != nil {
		return domain.Identity{}, err
	}
	store := pemBytes
	if len(passphrase) > 0 {
		raw, err := ssh.ParseRawPrivateKeyWithPassphrase(pemBytes, passphrase)
		if err != nil {
			return domain.Identity{}, err
		}
		blk, err := ssh.MarshalPrivateKey(normalizeKey(raw), name)
		if err != nil {
			return domain.Identity{}, err
		}
		store = pem.EncodeToMemory(blk)
	}
	ref, err := c.Vault.AddSecret(domain.SecretPrivateKey, store)
	if err != nil {
		return domain.Identity{}, err
	}
	id, err := c.Store.SaveIdentity(domain.Identity{Name: name, AuthType: domain.AuthKey, SecretRef: ref, PublicKey: vault.PublicLine(signer)})
	if err != nil {
		_ = c.Vault.DeleteSecret(ref)
		return id, err
	}
	return id, nil
}

func normalizeKey(k any) any {
	switch v := k.(type) {
	case *ed25519.PrivateKey:
		return *v
	case *rsa.PrivateKey:
		return v
	}
	return k
}

func (s *VaultService) AddPassword(name, user, pw string) (domain.Identity, error) {
	if !s.c.Vault.Status().Unlocked {
		return domain.Identity{}, errNotUnlocked
	}
	if strings.TrimSpace(name) == "" || pw == "" {
		return domain.Identity{}, errors.New("name and password are required")
	}
	ref, err := s.c.Vault.AddSecret(domain.SecretPassword, []byte(pw))
	if err != nil {
		return domain.Identity{}, err
	}
	id, err := s.c.Store.SaveIdentity(domain.Identity{Name: name, Username: user, AuthType: domain.AuthPassword, SecretRef: ref})
	if err != nil {
		_ = s.c.Vault.DeleteSecret(ref)
	}
	return id, err
}

// AddAgent registers an identity that authenticates through the running ssh-agent.
func (s *VaultService) AddAgent(name, user string) (domain.Identity, error) {
	return s.c.Store.SaveIdentity(domain.Identity{Name: name, Username: user, AuthType: domain.AuthAgent})
}

// GenerateKey creates an ed25519 key pair, stores the private half in the vault and returns
// only the public identity.
func (s *VaultService) GenerateKey(name, keyType string) (domain.Identity, error) {
	if keyType != "" && keyType != "ed25519" {
		return domain.Identity{}, fmt.Errorf("unsupported key type %q (only ed25519)", keyType)
	}
	if !s.c.Vault.Status().Unlocked {
		return domain.Identity{}, errNotUnlocked
	}
	priv, pub, err := vault.GenerateEd25519(name)
	if err != nil {
		return domain.Identity{}, err
	}
	ref, err := s.c.Vault.AddSecret(domain.SecretPrivateKey, priv)
	if err != nil {
		return domain.Identity{}, err
	}
	id, err := s.c.Store.SaveIdentity(domain.Identity{Name: name, AuthType: domain.AuthKey, SecretRef: ref, PublicKey: pub})
	if err != nil {
		_ = s.c.Vault.DeleteSecret(ref)
	}
	return id, err
}

// PublicKey returns the authorized_keys line of a key identity.
func (s *VaultService) PublicKey(id string) (string, error) {
	x, err := s.c.Store.GetIdentity(id)
	if err != nil {
		return "", err
	}
	if x.PublicKey == "" {
		return "", errors.New("identity has no public key")
	}
	return x.PublicKey, nil
}

// DeleteIdentity removes an identity and its secret. It fails while a host uses it.
func (s *VaultService) DeleteIdentity(id string) error {
	x, err := s.c.Store.GetIdentity(id)
	if err != nil {
		return err
	}
	if err := s.c.Store.DeleteIdentity(id); err != nil {
		return err
	}
	if x.SecretRef != "" {
		_ = s.c.Vault.DeleteSecret(x.SecretRef)
	}
	return nil
}
