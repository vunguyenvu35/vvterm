// Package store persists non-secret configuration (hosts.json) with atomic writes.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"vvterm/internal/domain"
)

const dataVersion = 1

var ErrNotFound = domain.ErrNotFound

// Store is a goroutine-safe in-memory model persisted through a Persister. Deletes are tombstones.
type Store struct {
	mu   sync.RWMutex
	p    Persister
	data domain.Data
	now  func() time.Time
}

// Open loads hosts.json from dir (JSON file persistence), creating an empty store if absent.
func Open(dir string) (*Store, error) {
	return OpenWith(JSONFile{Path: filepath.Join(dir, "hosts.json")})
}

// OpenWith builds a store on any Persister (JSON file, SQLite, ...).
func OpenWith(p Persister) (*Store, error) {
	s := &Store{p: p, now: func() time.Time { return time.Now().UTC() }}
	s.data.Version = dataVersion
	d, found, err := p.Load()
	if err != nil {
		return nil, err
	}
	if found {
		s.data = d
		if s.data.Version == 0 {
			s.data.Version = dataVersion
		}
	}
	return s, nil
}

// SetClock overrides the time source (tests).
func (s *Store) SetClock(f func() time.Time) { s.now = f }

func (s *Store) flush() error { return s.p.Save(s.data) }

// Snapshot returns a deep copy of all data including tombstones (used by sync/export).
func (s *Store) Snapshot() domain.Data {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return clone(s.data)
}

// Replace overwrites all data (used by sync and backup restore).
func (s *Store) Replace(d domain.Data) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d.Version = dataVersion
	s.data = clone(d)
	return s.flush()
}

func clone(d domain.Data) domain.Data {
	b, _ := json.Marshal(d)
	var out domain.Data
	_ = json.Unmarshal(b, &out)
	return out
}

func (s *Store) touch(m *domain.Meta) {
	if m.ID == "" {
		m.ID = domain.NewID()
	}
	m.UpdatedAt = s.now()
	m.DeletedAt = nil
}

// ---- Groups ----

func (s *Store) ListGroups() []domain.Group {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.Group{}
	for _, g := range s.data.Groups {
		if !g.Deleted() {
			out = append(out, g)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func (s *Store) SaveGroup(g domain.Group) (domain.Group, error) {
	if strings.TrimSpace(g.Name) == "" {
		return g, errors.New("group name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if g.ParentID != "" {
		if g.ParentID == g.ID {
			return g, errors.New("group cannot be its own parent")
		}
		if s.groupIdx(g.ParentID) < 0 {
			return g, fmt.Errorf("parent group: %w", ErrNotFound)
		}
		// reject cycles
		for p, n := g.ParentID, 0; p != "" && n < 64; n++ {
			if p == g.ID {
				return g, errors.New("group parent would create a cycle")
			}
			i := s.groupIdx(p)
			if i < 0 {
				break
			}
			p = s.data.Groups[i].ParentID
		}
	}
	s.touch(&g.Meta)
	if i := s.groupIdx(g.ID); i >= 0 {
		s.data.Groups[i] = g
	} else {
		s.data.Groups = append(s.data.Groups, g)
	}
	return g, s.flush()
}

func (s *Store) groupIdx(id string) int {
	for i, g := range s.data.Groups {
		if g.ID == id && !g.Deleted() {
			return i
		}
	}
	return -1
}

// DeleteGroup tombstones the group; child groups and hosts move to the parent.
func (s *Store) DeleteGroup(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.groupIdx(id)
	if i < 0 {
		return ErrNotFound
	}
	parent := s.data.Groups[i].ParentID
	now := s.now()
	for j := range s.data.Groups {
		if s.data.Groups[j].ParentID == id && !s.data.Groups[j].Deleted() {
			s.data.Groups[j].ParentID = parent
			s.data.Groups[j].UpdatedAt = now
		}
	}
	for j := range s.data.Hosts {
		if s.data.Hosts[j].GroupID == id && !s.data.Hosts[j].Deleted() {
			s.data.Hosts[j].GroupID = parent
			s.data.Hosts[j].UpdatedAt = now
		}
	}
	s.data.Groups[i].DeletedAt = &now
	s.data.Groups[i].UpdatedAt = now
	return s.flush()
}

// ---- Hosts ----

func (s *Store) hostIdx(id string) int {
	for i, h := range s.data.Hosts {
		if h.ID == id && !h.Deleted() {
			return i
		}
	}
	return -1
}

func (s *Store) GetHost(id string) (domain.Host, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if i := s.hostIdx(id); i >= 0 {
		return s.data.Hosts[i], nil
	}
	return domain.Host{}, ErrNotFound
}

func (s *Store) ListHosts(f domain.HostFilter) []domain.Host {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := strings.ToLower(strings.TrimSpace(f.Query))
	out := []domain.Host{}
	for _, h := range s.data.Hosts {
		if h.Deleted() {
			continue
		}
		if f.GroupID != "" && h.GroupID != f.GroupID {
			continue
		}
		if f.Env != "" && h.Env != f.Env {
			continue
		}
		if f.Tag != "" && !contains(h.Tags, f.Tag) {
			continue
		}
		if q != "" {
			hay := strings.ToLower(h.Label + " " + h.Hostname + " " + h.Username + " " + strings.Join(h.Tags, " "))
			if !strings.Contains(hay, q) {
				continue
			}
		}
		out = append(out, h)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i].Label) < strings.ToLower(out[j].Label)
	})
	return out
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}

const MaxJumpDepth = domain.MaxJumpDepth

func (s *Store) SaveHost(h domain.Host) (domain.Host, error) {
	if err := domain.NormalizeHost(&h); err != nil {
		return h, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if h.GroupID != "" && s.groupIdx(h.GroupID) < 0 {
		return h, fmt.Errorf("group: %w", ErrNotFound)
	}
	if h.IdentityID != "" && s.identIdx(h.IdentityID) < 0 {
		return h, fmt.Errorf("identity: %w", ErrNotFound)
	}
	if h.JumpHostID != "" {
		if err := s.checkJump(h.ID, h.JumpHostID); err != nil {
			return h, err
		}
	}
	existing := s.hostIdx(h.ID)
	s.touch(&h.Meta)
	if existing >= 0 {
		h.CreatedAt = s.data.Hosts[existing].CreatedAt
		s.data.Hosts[existing] = h
	} else {
		h.CreatedAt = h.UpdatedAt
		s.data.Hosts = append(s.data.Hosts, h)
	}
	return h, s.flush()
}

func (s *Store) checkJump(self, jump string) error {
	return domain.CheckJumpChain(self, jump, func(id string) (domain.Host, bool) {
		if i := s.hostIdx(id); i >= 0 {
			return s.data.Hosts[i], true
		}
		return domain.Host{}, false
	})
}

// DeleteHost tombstones the host and its port forwards; hosts jumping through it lose the jump.
func (s *Store) DeleteHost(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.hostIdx(id)
	if i < 0 {
		return ErrNotFound
	}
	now := s.now()
	s.data.Hosts[i].DeletedAt = &now
	s.data.Hosts[i].UpdatedAt = now
	for j := range s.data.Hosts {
		if s.data.Hosts[j].JumpHostID == id && !s.data.Hosts[j].Deleted() {
			s.data.Hosts[j].JumpHostID = ""
			s.data.Hosts[j].UpdatedAt = now
		}
	}
	for j := range s.data.Forwards {
		if s.data.Forwards[j].HostID == id && !s.data.Forwards[j].Deleted() {
			s.data.Forwards[j].DeletedAt = &now
			s.data.Forwards[j].UpdatedAt = now
		}
	}
	return s.flush()
}

// JumpChain returns the hosts to traverse, outermost jump first, ending with the target.
func (s *Store) JumpChain(hostID string) ([]domain.Host, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var rev []domain.Host
	for id, n := hostID, 0; id != ""; n++ {
		if n >= MaxJumpDepth {
			return nil, errors.New("jump host chain too deep")
		}
		i := s.hostIdx(id)
		if i < 0 {
			return nil, fmt.Errorf("host %s: %w", id, ErrNotFound)
		}
		rev = append(rev, s.data.Hosts[i])
		id = s.data.Hosts[i].JumpHostID
	}
	out := make([]domain.Host, len(rev))
	for i, h := range rev {
		out[len(rev)-1-i] = h
	}
	return out, nil
}

// ---- Identities ----

func (s *Store) identIdx(id string) int {
	for i, x := range s.data.Identities {
		if x.ID == id && !x.Deleted() {
			return i
		}
	}
	return -1
}

func (s *Store) ListIdentities() []domain.Identity {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.Identity{}
	for _, x := range s.data.Identities {
		if !x.Deleted() {
			out = append(out, x)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

func (s *Store) GetIdentity(id string) (domain.Identity, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if i := s.identIdx(id); i >= 0 {
		return s.data.Identities[i], nil
	}
	return domain.Identity{}, ErrNotFound
}

func (s *Store) SaveIdentity(x domain.Identity) (domain.Identity, error) {
	if strings.TrimSpace(x.Name) == "" {
		return x, errors.New("identity name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.touch(&x.Meta)
	if i := s.identIdx(x.ID); i >= 0 {
		s.data.Identities[i] = x
	} else {
		s.data.Identities = append(s.data.Identities, x)
	}
	return x, s.flush()
}

func (s *Store) DeleteIdentity(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.identIdx(id)
	if i < 0 {
		return ErrNotFound
	}
	for _, h := range s.data.Hosts {
		if h.IdentityID == id && !h.Deleted() {
			return fmt.Errorf("identity is used by host %q", h.Label)
		}
	}
	now := s.now()
	s.data.Identities[i].DeletedAt = &now
	s.data.Identities[i].UpdatedAt = now
	return s.flush()
}

// ---- Port forwards ----

func (s *Store) fwdIdx(id string) int {
	for i, f := range s.data.Forwards {
		if f.ID == id && !f.Deleted() {
			return i
		}
	}
	return -1
}

func (s *Store) ListForwards(hostID string) []domain.PortForward {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.PortForward{}
	for _, f := range s.data.Forwards {
		if !f.Deleted() && (hostID == "" || f.HostID == hostID) {
			out = append(out, f)
		}
	}
	return out
}

func (s *Store) GetForward(id string) (domain.PortForward, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if i := s.fwdIdx(id); i >= 0 {
		return s.data.Forwards[i], nil
	}
	return domain.PortForward{}, ErrNotFound
}

func (s *Store) SaveForward(f domain.PortForward) (domain.PortForward, error) {
	if err := domain.NormalizeForward(&f); err != nil {
		return f, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hostIdx(f.HostID) < 0 {
		return f, fmt.Errorf("host: %w", ErrNotFound)
	}
	s.touch(&f.Meta)
	if i := s.fwdIdx(f.ID); i >= 0 {
		s.data.Forwards[i] = f
	} else {
		s.data.Forwards = append(s.data.Forwards, f)
	}
	return f, s.flush()
}

func (s *Store) DeleteForward(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.fwdIdx(id)
	if i < 0 {
		return ErrNotFound
	}
	now := s.now()
	s.data.Forwards[i].DeletedAt = &now
	s.data.Forwards[i].UpdatedAt = now
	return s.flush()
}
