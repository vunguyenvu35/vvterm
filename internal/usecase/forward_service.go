package usecase

import (
	"errors"
	"fmt"
	"sync"

	"vvterm/internal/domain"
	"vvterm/internal/forward"
	"vvterm/internal/sshx"
)

// ForwardStatus is what the frontend sees for each configured forward.
type ForwardStatus struct {
	Forward domain.PortForward `json:"forward"`
	State   string             `json:"state"` // stopped | running | error
	Addr    string             `json:"addr,omitempty"`
	Error   string             `json:"error,omitempty"`
}

type running struct {
	fwd    *forward.Forward
	owner  string       // session id, or "" for a dedicated connection
	client *sshx.Client // set only for dedicated connections
}

// ForwardService starts and stops port forwards. A forward rides on an open terminal session
// to its host when there is one, otherwise it opens a dedicated connection.
type ForwardService struct {
	c        *Core
	sessions *SessionService

	mu       sync.Mutex
	active   map[string]*running
	lastErr  map[string]string
	starting map[string]bool
}

func NewForwardService(c *Core) *ForwardService {
	return &ForwardService{c: c, active: map[string]*running{}, lastErr: map[string]string{}, starting: map[string]bool{}}
}

func (s *ForwardService) SaveForward(f domain.PortForward) (domain.PortForward, error) {
	return s.c.Store.SaveForward(f)
}

func (s *ForwardService) DeleteForward(id string) error {
	_ = s.Stop(id)
	return s.c.Store.DeleteForward(id)
}

func (s *ForwardService) state(id string, addr string, st string, errMsg string) {
	s.c.emit("forward:state", map[string]any{"id": id, "state": st, "addr": addr, "error": errMsg})
}

// List returns every configured forward with its runtime state.
func (s *ForwardService) List() []ForwardStatus {
	out := []ForwardStatus{}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.c.Store.ListForwards("") {
		st := ForwardStatus{Forward: f, State: "stopped"}
		if r, ok := s.active[f.ID]; ok {
			st.State, st.Addr = "running", r.fwd.Addr
		} else if e := s.lastErr[f.ID]; e != "" {
			st.State, st.Error = "error", e
		}
		out = append(out, st)
	}
	return out
}

// Start brings a forward up. It blocks while connecting (a host key prompt may appear as
// term:hostkey:fwd-<id>).
func (s *ForwardService) Start(forwardID string) error {
	spec, err := s.c.Store.GetForward(forwardID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if _, ok := s.active[forwardID]; ok || s.starting[forwardID] {
		s.mu.Unlock()
		return errors.New("forward is already running")
	}
	s.starting[forwardID] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.starting, forwardID); s.mu.Unlock() }()

	var (
		cl    *sshx.Client
		owner string
		own   *sshx.Client
	)
	if s.sessions != nil {
		cl, owner = s.sessions.activeClient(spec.HostID)
	}
	if cl == nil {
		dc, _, err := s.c.connect(spec.HostID, "fwd-"+forwardID, make(chan struct{}))
		if err != nil {
			s.fail(forwardID, err)
			return err
		}
		cl, own = dc, dc
	}
	f, err := forward.Start(cl, spec)
	if err != nil {
		if own != nil {
			own.Close()
		}
		s.fail(forwardID, err)
		return err
	}
	s.mu.Lock()
	s.active[forwardID] = &running{fwd: f, owner: owner, client: own}
	delete(s.lastErr, forwardID)
	s.mu.Unlock()
	s.state(forwardID, f.Addr, "running", "")
	s.c.record(domain.ActForward, spec.HostID, "", fmt.Sprintf("Started %s forward %s (listening on %s)", spec.Type, forwardName(spec), f.Addr), true)
	if own != nil {
		go func() { // dedicated link dropped: tear the forward down
			_ = own.Wait()
			s.stopIf(forwardID, f)
		}()
	}
	return nil
}

func (s *ForwardService) fail(id string, err error) {
	if spec, gerr := s.c.Store.GetForward(id); gerr == nil {
		s.c.record(domain.ActForward, spec.HostID, "", fmt.Sprintf("Could not start %s forward %s: %v", spec.Type, forwardName(spec), err), false)
	}
	s.mu.Lock()
	s.lastErr[id] = err.Error()
	s.mu.Unlock()
	s.state(id, "", "error", err.Error())
}

// Stop shuts a forward down and closes its dedicated connection, if it has one.
func (s *ForwardService) Stop(forwardID string) error {
	s.mu.Lock()
	r, ok := s.active[forwardID]
	delete(s.active, forwardID)
	delete(s.lastErr, forwardID)
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("forward is not running")
	}
	s.shutdown(forwardID, r)
	if spec, err := s.c.Store.GetForward(forwardID); err == nil {
		s.c.record(domain.ActForward, spec.HostID, "", fmt.Sprintf("Stopped %s forward %s", spec.Type, forwardName(spec)), true)
	}
	return nil
}

// forwardName is how a rule is called in the log: its label, or its type.
func forwardName(f domain.PortForward) string {
	if f.Label != "" {
		return "\"" + f.Label + "\""
	}
	return fmt.Sprintf("%s:%d", f.BindAddr, f.BindPort)
}

func (s *ForwardService) stopIf(id string, f *forward.Forward) {
	s.mu.Lock()
	r, ok := s.active[id]
	if ok && r.fwd == f {
		delete(s.active, id)
	} else {
		ok = false
	}
	s.mu.Unlock()
	if ok {
		s.shutdown(id, r)
	}
}

func (s *ForwardService) shutdown(id string, r *running) {
	r.fwd.Stop()
	if r.client != nil {
		r.client.Close()
	}
	s.state(id, "", "stopped", "")
}

// stopOwned stops forwards that rode on a session which just ended.
func (s *ForwardService) stopOwned(sid string) {
	s.mu.Lock()
	var ids []string
	var rs []*running
	for id, r := range s.active {
		if r.owner == sid {
			ids = append(ids, id)
			rs = append(rs, r)
			delete(s.active, id)
		}
	}
	s.mu.Unlock()
	for i, r := range rs {
		s.shutdown(ids[i], r)
	}
}

// autoStart (re)creates forwards flagged auto_start once a session is connected.
func (s *ForwardService) autoStart(sid string, cl *sshx.Client, hostID string) {
	for _, spec := range s.c.Store.ListForwards(hostID) {
		if !spec.AutoStart {
			continue
		}
		s.mu.Lock()
		_, busy := s.active[spec.ID]
		s.mu.Unlock()
		if busy {
			continue
		}
		f, err := forward.Start(cl, spec)
		if err != nil {
			s.fail(spec.ID, err)
			continue
		}
		s.mu.Lock()
		s.active[spec.ID] = &running{fwd: f, owner: sid}
		delete(s.lastErr, spec.ID)
		s.mu.Unlock()
		s.state(spec.ID, f.Addr, "running", "")
	}
}

// StopAll stops every forward (app shutdown).
func (s *ForwardService) StopAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.active))
	for id := range s.active {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		_ = s.Stop(id)
	}
}
