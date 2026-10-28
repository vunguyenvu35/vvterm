package usecase

import (
	"errors"
	"fmt"
	"path"
	"strings"
	"sync"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/sshx"
)

// SftpInfo describes a new SFTP session.
type SftpInfo struct {
	SID  string `json:"sid"`
	Home string `json:"home"`
	Host string `json:"host"`
}

type sftpSession struct {
	hostID string
	label  string
	fs     RemoteFS
	client *sshx.Client
	stop   chan struct{}
	once   sync.Once
}

func (s *sftpSession) close() {
	s.once.Do(func() {
		close(s.stop)
		_ = s.fs.Close()
		_ = s.client.Close()
	})
}

// SftpService browses and transfers files over SFTP. Each session has its own SSH connection (through
// the host's jump chain), so it does not depend on an open terminal. Events: term:hostkey:<promptKey>
// (unknown host key), sftp:progress:<sid> (transfers) and sftp:closed:<sid> (connection lost).
type SftpService struct {
	c *Core

	mu       sync.Mutex
	sessions map[string]*sftpSession
}

func NewSftpService(c *Core) *SftpService {
	return &SftpService{c: c, sessions: map[string]*sftpSession{}}
}

// Open connects and starts SFTP. It blocks while an unknown host key waits for confirmation.
func (s *SftpService) Open(hostID, promptKey string) (SftpInfo, error) {
	if s.c.OpenRemoteFS == nil {
		return SftpInfo{}, errors.New("SFTP is not available in this build")
	}
	if strings.TrimSpace(promptKey) == "" {
		return SftpInfo{}, errors.New("a prompt key is required")
	}
	cl, host, err := s.c.connect(hostID, promptKey, make(chan struct{}))
	if err != nil {
		s.c.record(domain.ActSFTP, hostID, "", "SFTP connection failed: "+err.Error(), false)
		return SftpInfo{}, err
	}
	fs, err := s.c.OpenRemoteFS(cl)
	if err != nil {
		_ = cl.Close()
		return SftpInfo{}, err
	}
	home, err := fs.Home()
	if err != nil {
		_ = fs.Close()
		_ = cl.Close()
		return SftpInfo{}, fmt.Errorf("read the remote home directory: %w", err)
	}
	sess := &sftpSession{hostID: host.ID, label: host.Label, fs: fs, client: cl, stop: make(chan struct{})}
	s.c.record(domain.ActSFTP, host.ID, host.Label, "SFTP connection opened", true)
	sid := domain.NewID()
	s.mu.Lock()
	s.sessions[sid] = sess
	s.mu.Unlock()

	go sshx.Keepalive(cl, time.Duration(host.KeepaliveSec)*time.Second, 3, sess.stop, nil)
	s.c.learnOS(host, cl)
	go func() { // the SSH connection ended (network loss, server restart)
		_ = cl.Wait()
		s.mu.Lock()
		_, still := s.sessions[sid]
		delete(s.sessions, sid)
		s.mu.Unlock()
		sess.close()
		if still {
			s.c.emit("sftp:closed:"+sid, map[string]any{"reason": "connection lost"})
			s.c.record(domain.ActSFTP, sess.hostID, sess.label, "SFTP connection lost", false)
		}
	}()
	return SftpInfo{SID: sid, Home: home, Host: host.Label}, nil
}

func (s *SftpService) get(sid string) (*sftpSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if x, ok := s.sessions[sid]; ok {
		return x, nil
	}
	return nil, errors.New("the SFTP session is closed: reconnect")
}

func (s *SftpService) List(sid, dir string) ([]domain.RemoteEntry, error) {
	x, err := s.get(sid)
	if err != nil {
		return nil, err
	}
	return x.fs.List(dir)
}

func (s *SftpService) Mkdir(sid, p string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.fs.Mkdir(p)
}

func (s *SftpService) Rename(sid, from, to string) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.fs.Rename(from, to)
}

// Chmod sets the permission bits of a remote file or folder (an octal number such as 0o644).
func (s *SftpService) Chmod(sid, p string, mode int) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	if mode < 0 || mode > 0o7777 {
		return errors.New("permissions out of range")
	}
	return x.fs.Chmod(p, uint32(mode))
}

// Delete removes a file or directory; recursive is required for a non-empty directory.
func (s *SftpService) Delete(sid, p string, recursive bool) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.fs.Remove(p, recursive)
}

// progress returns a throttled callback that emits sftp:progress:<sid>.
func (s *SftpService) progress(sid, name, direction string) func(done, total int64) {
	var last time.Time
	return func(done, total int64) {
		if now := time.Now(); done < total && now.Sub(last) < 100*time.Millisecond {
			return
		} else {
			last = now
		}
		s.c.emit("sftp:progress:"+sid, map[string]any{"name": name, "direction": direction, "done": done, "total": total})
	}
}

// Upload sends a local file into remoteDir and returns the remote path it created.
func (s *SftpService) Upload(sid, local, remoteDir string, overwrite bool) (string, error) {
	x, err := s.get(sid)
	if err != nil {
		return "", err
	}
	name := baseName(local)
	if name == "" {
		return "", errors.New("invalid local file")
	}
	dest := path.Join(remoteDir, name)
	return dest, x.fs.Upload(local, dest, overwrite, s.progress(sid, name, "upload"))
}

// Download saves a remote file to the absolute local path.
func (s *SftpService) Download(sid, remote, local string, overwrite bool) error {
	x, err := s.get(sid)
	if err != nil {
		return err
	}
	return x.fs.Download(remote, local, overwrite, s.progress(sid, path.Base(remote), "download"))
}

func (s *SftpService) Close(sid string) error {
	s.mu.Lock()
	x, ok := s.sessions[sid]
	delete(s.sessions, sid)
	s.mu.Unlock()
	if ok {
		x.close()
	}
	return nil
}

// CloseAll ends every session (app shutdown).
func (s *SftpService) CloseAll() {
	s.mu.Lock()
	all := s.sessions
	s.sessions = map[string]*sftpSession{}
	s.mu.Unlock()
	for _, x := range all {
		x.close()
	}
}

func baseName(local string) string {
	i := strings.LastIndexAny(local, `/\`)
	return strings.TrimSpace(local[i+1:])
}
