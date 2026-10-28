package vault

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vvterm/internal/domain"
)

const pw = "correct horse battery"

func fastKDF() KDFParams { return KDFParams{Memory: 64, Time: 1, Threads: 1} }

func newVault(t *testing.T) (*Vault, string, *MemKeychain) {
	t.Helper()
	dir := t.TempDir()
	kc := NewMemKeychain()
	v, err := New(dir, kc)
	if err != nil {
		t.Fatal(err)
	}
	v.SetKDF(fastKDF())
	return v, dir, kc
}

func TestCreateRejectsWeakPassword(t *testing.T) {
	v, _, _ := newVault(t)
	if err := v.Create("short"); err != ErrWeakPassword {
		t.Fatalf("got %v want ErrWeakPassword", err)
	}
	if v.Status().Exists {
		t.Fatal("vault must not exist after rejected create")
	}
}

func TestCreateTwiceFails(t *testing.T) {
	v, _, _ := newVault(t)
	if err := v.Create(pw); err != nil {
		t.Fatal(err)
	}
	if err := v.Create(pw); err != ErrExists {
		t.Fatalf("got %v want ErrExists", err)
	}
}

func TestSecretRoundTripAcrossReopen(t *testing.T) {
	v, dir, _ := newVault(t)
	if err := v.Create(pw); err != nil {
		t.Fatal(err)
	}
	id, err := v.AddSecret(domain.SecretPassword, []byte("hunter2"))
	if err != nil {
		t.Fatal(err)
	}
	v.Lock()
	if _, err := v.GetSecret(id); err != ErrLocked {
		t.Fatalf("locked vault returned %v", err)
	}

	v2, err := New(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := v2.Unlock("wrong password!!"); err != ErrBadPassword {
		t.Fatalf("wrong pw: got %v", err)
	}
	if err := v2.Unlock(pw); err != nil {
		t.Fatal(err)
	}
	got, err := v2.GetSecret(id)
	if err != nil || string(got) != "hunter2" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestCiphertextHasNoPlaintext(t *testing.T) {
	v, dir, _ := newVault(t)
	_ = v.Create(pw)
	_, _ = v.AddSecret(domain.SecretPrivateKey, []byte("TOP-SECRET-MARKER"))
	raw, _ := os.ReadFile(filepath.Join(dir, "vault.json"))
	if bytes.Contains(raw, []byte("TOP-SECRET-MARKER")) {
		t.Fatal("plaintext leaked into vault.json")
	}
	st, _ := os.Stat(filepath.Join(dir, "vault.json"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("vault.json perm %v, want 0600", st.Mode().Perm())
	}
}

func TestSwappedCiphertextIsRejected(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	a, _ := v.AddSecret(domain.SecretPassword, []byte("aaa"))
	b, _ := v.AddSecret(domain.SecretPassword, []byte("bbb"))
	s := v.Secrets()
	// swap ciphertext+nonce between records; AAD (secret id) must catch it
	s[0].Ciphertext, s[1].Ciphertext = s[1].Ciphertext, s[0].Ciphertext
	s[0].Nonce, s[1].Nonce = s[1].Nonce, s[0].Nonce
	if err := v.ReplaceSecrets(s); err != nil {
		t.Fatal(err)
	}
	if _, err := v.GetSecret(a); err == nil {
		t.Fatal("swapped secret a decrypted")
	}
	if _, err := v.GetSecret(b); err == nil {
		t.Fatal("swapped secret b decrypted")
	}
}

func TestChangePasswordKeepsSecrets(t *testing.T) {
	v, dir, _ := newVault(t)
	_ = v.Create(pw)
	id, _ := v.AddSecret(domain.SecretPassword, []byte("keep-me"))
	if err := v.ChangePassword("not the password", "another long password"); err != ErrBadPassword {
		t.Fatalf("got %v", err)
	}
	if err := v.ChangePassword(pw, "tiny"); err != ErrWeakPassword {
		t.Fatalf("got %v", err)
	}
	if err := v.ChangePassword(pw, "another long password"); err != nil {
		t.Fatal(err)
	}
	v.Lock()
	v2, _ := New(dir, nil)
	if err := v2.Unlock(pw); err != ErrBadPassword {
		t.Fatalf("old password still works: %v", err)
	}
	if err := v2.Unlock("another long password"); err != nil {
		t.Fatal(err)
	}
	if got, _ := v2.GetSecret(id); string(got) != "keep-me" {
		t.Fatalf("secret lost after password change: %q", got)
	}
}

func TestDeleteSecretWipesCiphertext(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	id, _ := v.AddSecret(domain.SecretPassword, []byte("x"))
	if err := v.DeleteSecret(id); err != nil {
		t.Fatal(err)
	}
	if _, err := v.GetSecret(id); err != ErrSecretMissing {
		t.Fatalf("got %v", err)
	}
	s := v.Secrets()
	if len(s) != 1 || s[0].DeletedAt == nil || len(s[0].Ciphertext) != 0 {
		t.Fatalf("tombstone not kept correctly: %+v", s)
	}
}

func TestKeychainQuickUnlock(t *testing.T) {
	v, dir, kc := newVault(t)
	_ = v.Create(pw)
	id, _ := v.AddSecret(domain.SecretPassword, []byte("zzz"))
	if err := v.EnableKeychain(); err != nil {
		t.Fatal(err)
	}
	if !v.Status().KeychainEnabled {
		t.Fatal("keychain should be enabled")
	}
	v.Lock()
	v2, _ := New(dir, kc)
	if err := v2.UnlockKeychain(); err != nil {
		t.Fatal(err)
	}
	if got, _ := v2.GetSecret(id); string(got) != "zzz" {
		t.Fatalf("got %q", got)
	}
	if err := v2.DisableKeychain(); err != nil {
		t.Fatal(err)
	}
	v2.Lock()
	if err := v2.UnlockKeychain(); err != ErrNoKeychain {
		t.Fatalf("got %v", err)
	}
}

func TestKeychainWithForeignDEKIsRejectedAndPurged(t *testing.T) {
	v, dir, kc := newVault(t)
	_ = v.Create(pw)
	_, _ = v.AddSecret(domain.SecretPassword, []byte("zzz"))
	v.Lock()
	_ = kc.Set("vvterm", dir, bytes.Repeat([]byte{7}, 32))
	if err := v.UnlockKeychain(); err != ErrNoKeychain {
		t.Fatalf("got %v", err)
	}
	if _, err := kc.Get("vvterm", dir); err == nil {
		t.Fatal("bad DEK should have been purged from keychain")
	}
}

func TestEnableKeychainRequiresUnlock(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	v.Lock()
	if err := v.EnableKeychain(); err != ErrLocked {
		t.Fatalf("got %v", err)
	}
}

func TestAutoLockFiresCallback(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	fired := make(chan struct{}, 1)
	v.OnLock(func() { fired <- struct{}{} })
	v.SetAutoLock(50 * time.Millisecond)
	select {
	case <-fired:
	case <-time.After(2 * time.Second):
		t.Fatal("auto-lock did not fire")
	}
	if v.Status().Unlocked {
		t.Fatal("vault still unlocked after auto-lock")
	}
}

func TestActivityPostponesAutoLock(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	id, _ := v.AddSecret(domain.SecretPassword, []byte("a"))
	v.SetAutoLock(300 * time.Millisecond)
	for i := 0; i < 4; i++ {
		time.Sleep(120 * time.Millisecond)
		if _, err := v.GetSecret(id); err != nil {
			t.Fatalf("locked despite activity at iter %d: %v", i, err)
		}
	}
}

func TestManualLockFiresCallbackOnce(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	n := 0
	v.OnLock(func() { n++ })
	v.Lock()
	v.Lock()
	if n != 1 {
		t.Fatalf("callback fired %d times", n)
	}
}

func TestBlobSealOpenAndAAD(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	b, err := v.SealBlob([]byte("bundle"), []byte("aad1"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := v.OpenBlob(b, []byte("aad1")); err != nil || string(got) != "bundle" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := v.OpenBlob(b, []byte("other")); err == nil {
		t.Fatal("wrong AAD accepted")
	}
	b[len(b)-1] ^= 1
	if _, err := v.OpenBlob(b, []byte("aad1")); err == nil {
		t.Fatal("tampered blob accepted")
	}
}

func TestAdoptOnNewMachine(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	id, _ := v.AddSecret(domain.SecretPassword, []byte("shared"))
	h, _ := v.Header()
	secrets := v.Secrets()

	v2, _ := New(t.TempDir(), nil)
	if err := v2.Adopt("bad password here", h, secrets); err != ErrBadPassword {
		t.Fatalf("got %v", err)
	}
	if err := v2.Adopt(pw, h, secrets); err != nil {
		t.Fatal(err)
	}
	if got, _ := v2.GetSecret(id); string(got) != "shared" {
		t.Fatalf("got %q", got)
	}
}

func TestMaliciousKDFParamsRejected(t *testing.T) {
	v, _, _ := newVault(t)
	_ = v.Create(pw)
	h, _ := v.Header()
	h.KDF.Memory = 1 << 30 // 1 TiB
	v2, _ := New(t.TempDir(), nil)
	if err := v2.Adopt(pw, h, nil); err == nil || err == ErrBadPassword {
		t.Fatalf("expected KDF validation error, got %v", err)
	}
	h.KDF.Threads = 0
	h.KDF.Memory = 64
	if err := v2.Adopt(pw, h, nil); err == nil {
		t.Fatal("zero threads accepted")
	}
}

func TestPasswordBackupRoundTrip(t *testing.T) {
	blob, err := SealWithPassword("backup-pass", []byte(`{"a":1}`), fastKDF())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(blob), `"a":1`) {
		t.Fatal("plaintext in backup")
	}
	if got, err := OpenWithPassword("backup-pass", blob); err != nil || string(got) != `{"a":1}` {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := OpenWithPassword("nope", blob); err != ErrBadPassword {
		t.Fatalf("got %v", err)
	}
	if _, err := OpenWithPassword("x", []byte("garbage")); err == nil {
		t.Fatal("garbage accepted")
	}
	var m map[string]any
	_ = json.Unmarshal(blob, &m)
	m["kdf"] = map[string]any{"salt": "AAAAAAAAAAAAAAAAAAAAAA==", "m_kib": 4000000000, "t": 1, "p": 1}
	bad, _ := json.Marshal(m)
	if _, err := OpenWithPassword("x", bad); err == nil || err == ErrBadPassword {
		t.Fatalf("hostile KDF accepted: %v", err)
	}
}

func TestGenerateAndParseKey(t *testing.T) {
	priv, pub, err := GenerateEd25519("vvterm-test")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(pub, "ssh-ed25519 ") {
		t.Fatalf("pub = %q", pub)
	}
	s, err := ParsePrivateKey(priv, nil)
	if err != nil {
		t.Fatal(err)
	}
	if PublicLine(s) != strings.Fields(pub)[0]+" "+strings.Fields(pub)[1] {
		t.Fatalf("public mismatch: %q vs %q", PublicLine(s), pub)
	}
	if _, err := ParsePrivateKey([]byte("not a key"), nil); err == nil {
		t.Fatal("garbage parsed")
	}
}

func TestDestroyWorksWhileLockedAndClearsKeychain(t *testing.T) {
	v, dir, kc := newVault(t)
	_ = v.Create(pw)
	_, _ = v.AddSecret(domain.SecretPassword, []byte("x"))
	_ = v.EnableKeychain()
	v.Lock()
	if err := v.Destroy(); err != nil {
		t.Fatal(err)
	}
	if v.Status().Exists || v.Status().KeychainEnabled {
		t.Fatalf("%+v", v.Status())
	}
	if _, err := kc.Get("vvterm", dir); err == nil {
		t.Fatal("DEK left in the keychain")
	}
	if _, err := os.Stat(filepath.Join(dir, "vault.json")); !os.IsNotExist(err) {
		t.Fatalf("vault.json still exists: %v", err)
	}
	v2, _ := New(dir, nil)
	if v2.Status().Exists {
		t.Fatal("vault came back after reopen")
	}
	if err := v.Create("another long password"); err != nil {
		t.Fatalf("cannot create after destroy: %v", err)
	}
	if err := v.Destroy(); err != nil {
		t.Fatal(err)
	}
	if err := v.Destroy(); err != nil {
		t.Fatalf("destroy must be idempotent: %v", err)
	}
}
