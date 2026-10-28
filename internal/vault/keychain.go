package vault

import (
	"encoding/base64"

	"github.com/zalando/go-keyring"
)

// OSKeychain stores the DEK in macOS Keychain / Windows Credential Manager / Secret Service.
type OSKeychain struct{}

func (OSKeychain) Set(service, user string, secret []byte) error {
	return keyring.Set(service, user, base64.StdEncoding.EncodeToString(secret))
}

func (OSKeychain) Get(service, user string) ([]byte, error) {
	s, err := keyring.Get(service, user)
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(s)
}

func (OSKeychain) Delete(service, user string) error {
	err := keyring.Delete(service, user)
	if err == keyring.ErrNotFound {
		return nil
	}
	return err
}

// MemKeychain is an in-memory Keychain for tests and headless runs.
type MemKeychain struct{ m map[string][]byte }

func NewMemKeychain() *MemKeychain { return &MemKeychain{m: map[string][]byte{}} }

func (k *MemKeychain) Set(s, u string, b []byte) error {
	k.m[s+"/"+u] = append([]byte(nil), b...)
	return nil
}

func (k *MemKeychain) Get(s, u string) ([]byte, error) {
	b, ok := k.m[s+"/"+u]
	if !ok {
		return nil, keyring.ErrNotFound
	}
	return append([]byte(nil), b...), nil
}

func (k *MemKeychain) Delete(s, u string) error { delete(k.m, s+"/"+u); return nil }
