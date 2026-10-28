// Package sqlitedb is the SQLite adapter: one database file (vvterm.db) holds hosts, groups,
// identities, port forwards and the encrypted vault. It implements store.Persister and
// vault.Persister, so the rest of the app is unaware of the storage engine.
package sqlitedb

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, no CGO

	"vvterm/internal/domain"
	"vvterm/internal/vault"
)

// DB wraps the connection and exposes the persisters.
type DB struct{ db *sql.DB }

const schemaVersion = 1

var migrations = []string{
	// v1
	`CREATE TABLE groups (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
		sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, deleted_at TEXT);
	CREATE TABLE hosts (
		id TEXT PRIMARY KEY, label TEXT NOT NULL, group_id TEXT NOT NULL DEFAULT '', hostname TEXT NOT NULL,
		port INTEGER NOT NULL, username TEXT NOT NULL DEFAULT '', identity_id TEXT NOT NULL DEFAULT '',
		jump_host_id TEXT NOT NULL DEFAULT '', env TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
		keepalive_sec INTEGER NOT NULL DEFAULT 30, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
	CREATE INDEX idx_hosts_group ON hosts(group_id);
	CREATE TABLE identities (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', auth_type TEXT NOT NULL,
		secret_ref TEXT NOT NULL DEFAULT '', public_key TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
	CREATE TABLE port_forwards (
		id TEXT PRIMARY KEY, host_id TEXT NOT NULL, type TEXT NOT NULL, bind_addr TEXT NOT NULL, bind_port INTEGER NOT NULL,
		dest_host TEXT NOT NULL DEFAULT '', dest_port INTEGER NOT NULL DEFAULT 0, auto_start INTEGER NOT NULL DEFAULT 0,
		allow_public_bind INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, deleted_at TEXT);
	CREATE INDEX idx_forwards_host ON port_forwards(host_id);
	CREATE TABLE secrets (
		id TEXT PRIMARY KEY, kind TEXT NOT NULL, nonce BLOB, ciphertext BLOB, updated_at TEXT NOT NULL, deleted_at TEXT);
	CREATE TABLE vault_header (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);`,
}

// Open opens (creating and migrating if needed) the database at path with mode 0600.
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Add("_pragma", "foreign_keys(1)")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer; avoids SQLITE_BUSY between the store and the vault
	d := &DB{db: db}
	if err := d.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return d, nil
}

func (d *DB) Close() error { return d.db.Close() }

func (d *DB) migrate() error {
	var v int
	if err := d.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	if v > schemaVersion {
		return fmt.Errorf("database schema v%d is newer than this app supports (v%d)", v, schemaVersion)
	}
	for ; v < schemaVersion; v++ {
		tx, err := d.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[v]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migrate to v%d: %w", v+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, v+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// ---- time helpers ----

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func tsNull(t *time.Time) any {
	if t == nil {
		return nil
	}
	return ts(*t)
}

func parseTS(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

func parseTSNull(s sql.NullString) *time.Time {
	if !s.Valid {
		return nil
	}
	t := parseTS(s.String)
	return &t
}

// ---- store.Persister ----

// StorePersister returns the persister for hosts, groups, identities and forwards.
func (d *DB) StorePersister() StorePersister { return StorePersister{d.db} }

type StorePersister struct{ db *sql.DB }

// Load reads every row; found is false for a database that has never been saved to.
func (p StorePersister) Load() (domain.Data, bool, error) {
	var data domain.Data
	data.Version = 1
	rows, err := p.db.Query(`SELECT id,name,parent_id,color,sort_order,updated_at,deleted_at FROM groups ORDER BY rowid`)
	if err != nil {
		return data, false, err
	}
	for rows.Next() {
		var g domain.Group
		var upd string
		var del sql.NullString
		if err := rows.Scan(&g.ID, &g.Name, &g.ParentID, &g.Color, &g.SortOrder, &upd, &del); err != nil {
			rows.Close()
			return data, false, err
		}
		g.UpdatedAt, g.DeletedAt = parseTS(upd), parseTSNull(del)
		data.Groups = append(data.Groups, g)
	}
	rows.Close()

	rows, err = p.db.Query(`SELECT id,label,group_id,hostname,port,username,identity_id,jump_host_id,env,tags,keepalive_sec,created_at,updated_at,deleted_at FROM hosts ORDER BY rowid`)
	if err != nil {
		return data, false, err
	}
	for rows.Next() {
		var h domain.Host
		var env, tags, cr, upd string
		var del sql.NullString
		if err := rows.Scan(&h.ID, &h.Label, &h.GroupID, &h.Hostname, &h.Port, &h.Username, &h.IdentityID, &h.JumpHostID, &env, &tags, &h.KeepaliveSec, &cr, &upd, &del); err != nil {
			rows.Close()
			return data, false, err
		}
		h.Env = domain.Env(env)
		_ = json.Unmarshal([]byte(tags), &h.Tags)
		h.CreatedAt, h.UpdatedAt, h.DeletedAt = parseTS(cr), parseTS(upd), parseTSNull(del)
		data.Hosts = append(data.Hosts, h)
	}
	rows.Close()

	rows, err = p.db.Query(`SELECT id,name,username,auth_type,secret_ref,public_key,updated_at,deleted_at FROM identities ORDER BY rowid`)
	if err != nil {
		return data, false, err
	}
	for rows.Next() {
		var x domain.Identity
		var at, upd string
		var del sql.NullString
		if err := rows.Scan(&x.ID, &x.Name, &x.Username, &at, &x.SecretRef, &x.PublicKey, &upd, &del); err != nil {
			rows.Close()
			return data, false, err
		}
		x.AuthType = domain.AuthType(at)
		x.UpdatedAt, x.DeletedAt = parseTS(upd), parseTSNull(del)
		data.Identities = append(data.Identities, x)
	}
	rows.Close()

	rows, err = p.db.Query(`SELECT id,host_id,type,bind_addr,bind_port,dest_host,dest_port,auto_start,allow_public_bind,updated_at,deleted_at FROM port_forwards ORDER BY rowid`)
	if err != nil {
		return data, false, err
	}
	for rows.Next() {
		var f domain.PortForward
		var typ, upd string
		var auto, pub int
		var del sql.NullString
		if err := rows.Scan(&f.ID, &f.HostID, &typ, &f.BindAddr, &f.BindPort, &f.DestHost, &f.DestPort, &auto, &pub, &upd, &del); err != nil {
			rows.Close()
			return data, false, err
		}
		f.Type, f.AutoStart, f.AllowPublicBind = domain.ForwardType(typ), auto != 0, pub != 0
		f.UpdatedAt, f.DeletedAt = parseTS(upd), parseTSNull(del)
		data.Forwards = append(data.Forwards, f)
	}
	rows.Close()

	found := len(data.Groups)+len(data.Hosts)+len(data.Identities)+len(data.Forwards) > 0
	return data, found, nil
}

// Save replaces all rows in one transaction, so a crash never leaves a half-written state.
func (p StorePersister) Save(d domain.Data) error {
	tx, err := p.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, t := range []string{"groups", "hosts", "identities", "port_forwards"} {
		if _, err := tx.Exec("DELETE FROM " + t); err != nil {
			return err
		}
	}
	for _, g := range d.Groups {
		if _, err := tx.Exec(`INSERT INTO groups(id,name,parent_id,color,sort_order,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?)`,
			g.ID, g.Name, g.ParentID, g.Color, g.SortOrder, ts(g.UpdatedAt), tsNull(g.DeletedAt)); err != nil {
			return err
		}
	}
	for _, h := range d.Hosts {
		tags, _ := json.Marshal(h.Tags)
		if h.Tags == nil {
			tags = []byte("[]")
		}
		if _, err := tx.Exec(`INSERT INTO hosts(id,label,group_id,hostname,port,username,identity_id,jump_host_id,env,tags,keepalive_sec,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			h.ID, h.Label, h.GroupID, h.Hostname, h.Port, h.Username, h.IdentityID, h.JumpHostID, string(h.Env), string(tags),
			h.KeepaliveSec, ts(h.CreatedAt), ts(h.UpdatedAt), tsNull(h.DeletedAt)); err != nil {
			return err
		}
	}
	for _, x := range d.Identities {
		if _, err := tx.Exec(`INSERT INTO identities(id,name,username,auth_type,secret_ref,public_key,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)`,
			x.ID, x.Name, x.Username, string(x.AuthType), x.SecretRef, x.PublicKey, ts(x.UpdatedAt), tsNull(x.DeletedAt)); err != nil {
			return err
		}
	}
	for _, f := range d.Forwards {
		if _, err := tx.Exec(`INSERT INTO port_forwards(id,host_id,type,bind_addr,bind_port,dest_host,dest_port,auto_start,allow_public_bind,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
			f.ID, f.HostID, string(f.Type), f.BindAddr, f.BindPort, f.DestHost, f.DestPort, b2i(f.AutoStart), b2i(f.AllowPublicBind), ts(f.UpdatedAt), tsNull(f.DeletedAt)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ---- vault.Persister ----

// VaultPersister returns the persister for the encrypted vault.
func (d *DB) VaultPersister() VaultPersister { return VaultPersister{d.db} }

type VaultPersister struct{ db *sql.DB }

var _ vault.Persister = VaultPersister{}

// Load returns nil when no vault has been created.
func (p VaultPersister) Load() (*vault.Snapshot, error) {
	var hdr string
	err := p.db.QueryRow(`SELECT data FROM vault_header WHERE id = 1`).Scan(&hdr)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	snap := &vault.Snapshot{Secrets: []domain.Secret{}}
	if err := json.Unmarshal([]byte(hdr), &snap.Header); err != nil {
		return nil, fmt.Errorf("vault header: %w", err)
	}
	rows, err := p.db.Query(`SELECT id,kind,nonce,ciphertext,updated_at,deleted_at FROM secrets ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var s domain.Secret
		var kind, upd string
		var del sql.NullString
		if err := rows.Scan(&s.ID, &kind, &s.Nonce, &s.Ciphertext, &upd, &del); err != nil {
			return nil, err
		}
		s.Kind, s.UpdatedAt, s.DeletedAt = domain.SecretKind(kind), parseTS(upd), parseTSNull(del)
		snap.Secrets = append(snap.Secrets, s)
	}
	return snap, rows.Err()
}

func (p VaultPersister) Save(s *vault.Snapshot) error {
	hdr, err := json.Marshal(s.Header)
	if err != nil {
		return err
	}
	tx, err := p.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO vault_header(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, string(hdr)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM secrets`); err != nil {
		return err
	}
	for _, sec := range s.Secrets {
		if _, err := tx.Exec(`INSERT INTO secrets(id,kind,nonce,ciphertext,updated_at,deleted_at) VALUES(?,?,?,?,?,?)`,
			sec.ID, string(sec.Kind), sec.Nonce, sec.Ciphertext, ts(sec.UpdatedAt), tsNull(sec.DeletedAt)); err != nil {
			return err
		}
	}
	return tx.Commit()
}
