package vault

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"strings"

	"golang.org/x/crypto/ssh"
)

// GenerateEd25519 returns an OpenSSH-format private key (PEM) and its authorized_keys line.
func GenerateEd25519(comment string) (privPEM []byte, pubLine string, err error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	blk, err := ssh.MarshalPrivateKey(priv, comment)
	if err != nil {
		return nil, "", err
	}
	sp, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, "", err
	}
	return pem.EncodeToMemory(blk), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sp))), nil
}

// ParsePrivateKey validates a private key and derives its public key line.
// passphrase may be empty for unencrypted keys.
func ParsePrivateKey(pemBytes, passphrase []byte) (ssh.Signer, error) {
	var (
		s   ssh.Signer
		err error
	)
	if len(passphrase) > 0 {
		s, err = ssh.ParsePrivateKeyWithPassphrase(pemBytes, passphrase)
	} else {
		s, err = ssh.ParsePrivateKey(pemBytes)
	}
	if err != nil {
		var pm *ssh.PassphraseMissingError
		if errors.As(err, &pm) {
			return nil, errors.New("private key is encrypted: passphrase required")
		}
		return nil, err
	}
	return s, nil
}

// PublicLine returns the authorized_keys line of a signer.
func PublicLine(s ssh.Signer) string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.PublicKey())))
}
