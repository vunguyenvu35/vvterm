package sqlitedb

import (
	"fmt"
	"strings"

	"vvterm/internal/domain"
)

// maxActivityRows is how much history is kept; older lines are dropped as new ones arrive.
var maxActivityRows int64 = 5000

// ActivityLog stores the activity log in the same database. It implements usecase.ActivityLog.
type ActivityLog struct{ d *DB }

func (d *DB) ActivityLog() *ActivityLog { return &ActivityLog{d: d} }

func (a *ActivityLog) Add(e domain.ActivityEntry) error {
	if err := domain.NormalizeActivity(&e); err != nil {
		return err
	}
	tx, err := a.d.db.Begin()
	if err != nil {
		return err
	}
	res, err := tx.Exec(`INSERT INTO activity_log(at,kind,host_id,host_label,message,ok) VALUES(?,?,?,?,?,?)`,
		ts(e.At), e.Kind, e.HostID, e.HostLabel, e.Message, b2i(e.OK))
	if err != nil {
		tx.Rollback()
		return err
	}
	if id, err := res.LastInsertId(); err == nil && id > maxActivityRows {
		if _, err := tx.Exec(`DELETE FROM activity_log WHERE id <= ?`, id-maxActivityRows); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// List returns the newest lines first.
func (a *ActivityLog) List(f domain.ActivityFilter) ([]domain.ActivityEntry, error) {
	limit := f.Limit
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	var where []string
	var args []any
	if len(f.Kinds) > 0 {
		marks := strings.TrimSuffix(strings.Repeat("?,", len(f.Kinds)), ",")
		where = append(where, "kind IN ("+marks+")")
		for _, k := range f.Kinds {
			args = append(args, k)
		}
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
		where = append(where, `(message LIKE ? ESCAPE '\' OR host_label LIKE ? ESCAPE '\')`)
		args = append(args, like, like)
	}
	sqlText := `SELECT id,at,kind,host_id,host_label,message,ok FROM activity_log`
	if len(where) > 0 {
		sqlText += " WHERE " + strings.Join(where, " AND ")
	}
	sqlText += fmt.Sprintf(" ORDER BY id DESC LIMIT %d", limit)
	rows, err := a.d.db.Query(sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.ActivityEntry{}
	for rows.Next() {
		var e domain.ActivityEntry
		var at string
		var ok int
		if err := rows.Scan(&e.ID, &at, &e.Kind, &e.HostID, &e.HostLabel, &e.Message, &ok); err != nil {
			return nil, err
		}
		e.At, e.OK = parseTS(at), ok != 0
		out = append(out, e)
	}
	return out, rows.Err()
}

// Clear forgets the whole history.
func (a *ActivityLog) Clear() error {
	_, err := a.d.db.Exec(`DELETE FROM activity_log`)
	return err
}
