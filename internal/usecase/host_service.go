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

func (s *HostService) DeleteHost(id string) error { return s.c.Store.DeleteHost(id) }
