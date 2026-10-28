package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"vvterm/internal/fsutil"
)

// Persister stores the vault snapshot. Load returns nil when no vault exists yet.
type Persister interface {
	Load() (*Snapshot, error)
	Save(*Snapshot) error
}

// JSONFile persists the vault to one JSON file with atomic writes.
type JSONFile struct{ Path string }

func (j JSONFile) Load() (*Snapshot, error) {
	b, err := os.ReadFile(j.Path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return nil, nil
	case err != nil:
		return nil, err
	}
	var f Snapshot
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("parse vault: %w", err)
	}
	return &f, nil
}

func (j JSONFile) Save(f *Snapshot) error {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(j.Path, b, 0o600)
}
