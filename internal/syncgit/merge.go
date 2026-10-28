package syncgit

import "vvterm/internal/domain"

// Bundle and the merge rules are domain concepts; syncgit only transports them.
type Bundle = domain.Bundle

var (
	Merge           = domain.Merge
	PurgeTombstones = domain.PurgeTombstones
)
