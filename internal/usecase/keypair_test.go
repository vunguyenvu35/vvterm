package usecase

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/domain"
)

type pairFixture struct {
	pem, pub string
	signer   ssh.Signer
	priv     ed25519.PrivateKey
}

func newPair(t *testing.T) pairFixture {
	t.Helper()
	priv, pub := mustEd25519()
	blk, err := ssh.MarshalPrivateKey(priv, "test")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	sp, _ := ssh.NewPublicKey(pub)
	return pairFixture{pem: string(pemEncode(blk)), pub: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sp))), signer: signer, priv: priv}
}

func (p pairFixture) certificate(t *testing.T, mod func(*ssh.Certificate)) string {
	t.Helper()
	ca, _ := mustEd25519()
	caSigner, _ := ssh.NewSignerFromKey(ca)
	cert := &ssh.Certificate{Key: p.signer.PublicKey(), CertType: ssh.UserCert, KeyId: "alice", ValidPrincipals: []string{"root"}, ValidBefore: ssh.CertTimeInfinity}
	if mod != nil {
		mod(cert)
	}
	if err := cert.SignCert(rand.Reader, caSigner); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(cert)))
}

func TestAddKeyPairAcceptsAMatchingPublicKeyAndCertificate(t *testing.T) {
	h := newHarness(t).unlocked(t)
	p := newPair(t)
	cert := p.certificate(t, nil)
	id, err := h.app.Vault.AddKeyPair("deploy", p.pem, "", p.pub+" me@laptop", cert+" issued-by-ca")
	if err != nil {
		t.Fatal(err)
	}
	if id.PublicKey != p.pub || !strings.HasPrefix(id.Certificate, "ssh-ed25519-cert-v01@openssh.com ") {
		t.Fatalf("%+v", id)
	}
	if strings.Contains(id.Certificate, "issued-by-ca") {
		t.Fatal("the stored certificate is normalised: no comment")
	}
	list := h.app.Vault.ListIdentities()
	if len(list) != 1 || list[0].Certificate != id.Certificate {
		t.Fatalf("%+v", list)
	}
}

func TestAddKeyPairWithoutThePublicPartsIsAnOrdinaryImport(t *testing.T) {
	h := newHarness(t).unlocked(t)
	p := newPair(t)
	id, err := h.app.Vault.AddKeyPair("plain", p.pem, "", "  ", "")
	if err != nil || id.Certificate != "" || id.PublicKey != p.pub {
		t.Fatalf("%+v %v", id, err)
	}
}

func TestAddKeyPairRefusesWhatDoesNotBelong(t *testing.T) {
	h := newHarness(t).unlocked(t)
	p, other := newPair(t), newPair(t)
	cases := []struct{ name, pub, cert, want string }{
		{"someone else's public key", other.pub, "", "does not belong to this private key"},
		{"garbage public key", "not a key", "", "not in OpenSSH format"},
		{"garbage certificate", "", "ssh-ed25519-cert-v01@openssh.com AAAA", "not in OpenSSH format"},
		{"a plain key in the certificate box", "", p.pub, "not a certificate"},
		{"a certificate for another key", "", other.certificate(t, nil), "different key"},
		{"a host certificate", "", p.certificate(t, func(c *ssh.Certificate) { c.CertType = ssh.HostCert }), "host certificate"},
		{"an expired certificate", "", p.certificate(t, func(c *ssh.Certificate) { c.ValidAfter = 1; c.ValidBefore = uint64(time.Now().Add(-time.Hour).Unix()) }), "expired"},
	}
	for _, c := range cases {
		_, err := h.app.Vault.AddKeyPair("k", p.pem, "", c.pub, c.cert)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want %q", c.name, err, c.want)
		}
	}
	if n := len(h.app.Vault.ListIdentities()); n != 0 {
		t.Fatalf("a refused import stores nothing, but %d identities exist", n)
	}
	if _, err := h.app.Vault.AddKeyPair("k", p.pem, "", p.certificate(t, nil), ""); err != nil {
		t.Fatalf("a certificate pasted into the public key box still names the key: %v", err)
	}
}

func TestACertificateIdentityLogsInWithTheCertificate(t *testing.T) {
	h := newHarness(t).unlocked(t)
	p := newPair(t)
	id, err := h.app.Vault.AddKeyPair("cert-login", p.pem, "", "", p.certificate(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	host, err := h.app.Host.SaveHost(domain.Host{Label: "h", Hostname: "127.0.0.1", Port: 22, Username: "root", IdentityID: id.ID})
	if err != nil {
		t.Fatal(err)
	}
	hop, err := h.app.Core.hopFor(host)
	if err != nil || len(hop.Auth) != 1 {
		t.Fatalf("%v %+v", err, hop)
	}
	// a stored certificate that went bad is reported, not silently ignored
	bad := id
	bad.Certificate = "garbage"
	if _, err := h.app.Core.Store.SaveIdentity(bad); err != nil {
		t.Fatal(err)
	}
	if _, err := h.app.Core.hopFor(host); err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("%v", err)
	}
}

func TestAddKeyPairNeedsTheVaultUnlocked(t *testing.T) {
	h := newHarness(t).unlocked(t)
	p := newPair(t)
	h.app.Vault.Lock()
	if _, err := h.app.Vault.AddKeyPair("k", p.pem, "", p.pub, ""); err == nil {
		t.Fatal("locked")
	}
}
