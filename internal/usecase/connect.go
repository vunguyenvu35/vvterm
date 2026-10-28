package usecase

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/domain"
	"vvterm/internal/sshx"
	"vvterm/internal/vault"
)

// hopFor turns a host into a dialable hop, decrypting its identity inside Go.
func (c *Core) hopFor(h domain.Host) (sshx.Hop, error) {
	hop := sshx.Hop{Label: h.Label, Hostname: h.Hostname, Port: h.Port, Username: h.Username}
	if h.IdentityID == "" {
		a, err := sshx.AgentAuth()
		if err != nil {
			return hop, fmt.Errorf("host %q has no identity and no ssh-agent is available", h.Label)
		}
		hop.Auth = []ssh.AuthMethod{a}
		return hop, nil
	}
	id, err := c.Store.GetIdentity(h.IdentityID)
	if err != nil {
		return hop, fmt.Errorf("identity of %q: %w", h.Label, err)
	}
	if hop.Username == "" {
		hop.Username = id.Username
	}
	switch id.AuthType {
	case domain.AuthAgent:
		a, err := sshx.AgentAuth()
		if err != nil {
			return hop, err
		}
		hop.Auth = []ssh.AuthMethod{a}
	case domain.AuthPassword:
		pw, err := c.Vault.GetSecret(id.SecretRef)
		if err != nil {
			return hop, vaultErr(err)
		}
		hop.Auth = sshx.PasswordAuth(string(pw))
	case domain.AuthKey:
		pem, err := c.Vault.GetSecret(id.SecretRef)
		if err != nil {
			return hop, vaultErr(err)
		}
		signer, err := vault.ParsePrivateKey(pem, nil)
		if err != nil {
			return hop, fmt.Errorf("identity %q: %w", id.Name, err)
		}
		hop.Auth = []ssh.AuthMethod{sshx.KeyAuth(signer)}
	default:
		return hop, fmt.Errorf("unknown auth type %q", id.AuthType)
	}
	if hop.Username == "" {
		return hop, fmt.Errorf("no username for host %q", h.Label)
	}
	return hop, nil
}

func vaultErr(err error) error {
	if errors.Is(err, vault.ErrLocked) {
		return errNotUnlocked
	}
	return err
}

// hostKeyTimeout bounds how long a connection waits for the user to answer a fingerprint prompt.
const hostKeyTimeout = 2 * time.Minute

// connect dials the host (through its jump chain). Unknown host keys raise the
// term:hostkey:<promptKey> event and block until TrustHostKey answers.
func (c *Core) connect(hostID, promptKey string, abort <-chan struct{}) (*sshx.Client, domain.Host, error) {
	chain, err := c.Store.JumpChain(hostID)
	if err != nil {
		return nil, domain.Host{}, err
	}
	target := chain[len(chain)-1]
	hops := make([]sshx.Hop, len(chain))
	for i, h := range chain {
		if hops[i], err = c.hopFor(h); err != nil {
			return nil, target, err
		}
	}
	d := &sshx.Dialer{Timeout: c.Dialer.Timeout, HostKeys: &sshx.HostKeyChecker{
		Path: c.Dialer.HostKeys.Path,
		Prompt: func(host string, key ssh.PublicKey) (bool, error) {
			fp := sshx.Fingerprint(key)
			payload := map[string]any{"host": host, "fingerprint": fp, "key_type": key.Type()}
			ch := c.prompts.ask(promptKey, fp, payload)
			defer c.prompts.clear(promptKey)
			c.emit("term:hostkey:"+promptKey, payload)
			select {
			case ok := <-ch:
				return ok, nil
			case <-abort:
				return false, errors.New("cancelled")
			case <-time.After(hostKeyTimeout):
				return false, errors.New("timed out waiting for host key confirmation")
			}
		},
	}}
	cl, err := d.Dial(hops)
	return cl, target, err
}
