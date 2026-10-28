package vault

import "vvterm/internal/domain"

// The vault's data shapes are domain types; these aliases keep this package's API readable.
type (
	KDFParams   = domain.KDFParams
	Header      = domain.VaultHeader
	Status      = domain.VaultStatus
	PlainSecret = domain.PlainSecret
)
