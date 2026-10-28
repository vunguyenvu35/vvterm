package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"vvterm/internal/domain"
	"vvterm/internal/fsutil"
)

// Persister is where the store keeps its data. Save receives the complete data set.
type Persister interface {
	// Load returns the stored data; found is false when nothing has been saved yet.
	Load() (d domain.Data, found bool, err error)
	Save(domain.Data) error
}

// JSONFile persists to a single JSON file with atomic writes.
type JSONFile struct{ Path string }

func (j JSONFile) Load() (domain.Data, bool, error) {
	var d domain.Data
	b, err := os.ReadFile(j.Path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return d, false, nil
	case err != nil:
		return d, false, err
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return d, false, fmt.Errorf("parse %s: %w", j.Path, err)
	}
	return d, true, nil
}

func (j JSONFile) Save(d domain.Data) error {
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(j.Path, b, 0o600)
}
