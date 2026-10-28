package usecase

import (
	"vvterm/internal/domain"
)

// HostService manages groups and hosts. Deletes are tombstones.
type HostService struct{ c *Core }

func NewHostService(c *Core) *HostService { return &HostService{c} }

func (s *HostService) ListGroups() []domain.Group { return s.c.Store.ListGroups() }

func (s *HostService) SaveGroup(g domain.Group) (domain.Group, error) { return s.c.Store.SaveGroup(g) }

func (s *HostService) DeleteGroup(id string) error { return s.c.Store.DeleteGroup(id) }

func (s *HostService) ListHosts(f domain.HostFilter) []domain.Host { return s.c.Store.ListHosts(f) }

func (s *HostService) GetHost(id string) (domain.Host, error) { return s.c.Store.GetHost(id) }

func (s *HostService) SaveHost(h domain.Host) (domain.Host, error) { return s.c.Store.SaveHost(h) }

func (s *HostService) DeleteHost(id string) error {
	if err := s.c.Store.DeleteHost(id); err != nil {
		return err
	}
	if s.c.Vault != nil {
		_ = s.c.Vault.DeleteSecret(domain.TelnetSecretRef(id)) // nothing to delete is fine
	}
	return nil
}

// SetTelnetPassword keeps the Telnet password of a host in the vault; an empty password forgets it.
func (s *HostService) SetTelnetPassword(hostID, password string) error {
	if _, err := s.c.Store.GetHost(hostID); err != nil {
		return err
	}
	ref := domain.TelnetSecretRef(hostID)
	if password == "" {
		_ = s.c.Vault.DeleteSecret(ref)
		return nil
	}
	return vaultErr(s.c.Vault.PutSecret(ref, domain.SecretPassword, []byte(password)))
}
