package domain

import "time"

// Bundle is the plaintext that gets sealed into bundle.enc.
type Bundle struct {
	Data    Data     `json:"data"`
	Secrets []Secret `json:"secrets"`
}

// pick returns true when b should replace a (last-write-wins; on a tie a tombstone wins,
// then the remote side b is kept stable by returning false).
func pick(a, b Meta) bool {
	switch {
	case b.UpdatedAt.After(a.UpdatedAt):
		return true
	case a.UpdatedAt.After(b.UpdatedAt):
		return false
	}
	return b.Deleted() && !a.Deleted()
}

func mergeSlice[T any](local, remote []T, m func(T) Meta) []T {
	idx := map[string]int{}
	out := make([]T, 0, len(local)+len(remote))
	for _, l := range local {
		idx[m(l).ID] = len(out)
		out = append(out, l)
	}
	for _, r := range remote {
		i, ok := idx[m(r).ID]
		if !ok {
			idx[m(r).ID] = len(out)
			out = append(out, r)
			continue
		}
		if pick(m(out[i]), m(r)) {
			out[i] = r
		}
	}
	return out
}

// Merge combines two bundles record by record.
func Merge(local, remote Bundle) Bundle {
	var out Bundle
	out.Data.Version = local.Data.Version
	if out.Data.Version == 0 {
		out.Data.Version = remote.Data.Version
	}
	out.Data.Groups = mergeSlice(local.Data.Groups, remote.Data.Groups, func(g Group) Meta { return g.Meta })
	out.Data.Hosts = mergeSlice(local.Data.Hosts, remote.Data.Hosts, func(h Host) Meta { return h.Meta })
	out.Data.Forwards = mergeSlice(local.Data.Forwards, remote.Data.Forwards, func(f PortForward) Meta { return f.Meta })
	out.Data.Identities = mergeSlice(local.Data.Identities, remote.Data.Identities, func(x Identity) Meta { return x.Meta })
	out.Data.Snippets = mergeSlice(local.Data.Snippets, remote.Data.Snippets, func(x Snippet) Meta { return x.Meta })
	out.Secrets = mergeSlice(local.Secrets, remote.Secrets, func(s Secret) Meta { return s.Meta })
	return out
}

// PurgeTombstones drops tombstones older than the cutoff to keep the bundle small.
// Callers must only purge well after all devices have synced.
func PurgeTombstones(b Bundle, cutoff time.Time) Bundle {
	keep := func(m Meta) bool { return m.DeletedAt == nil || m.DeletedAt.After(cutoff) }
	var o Bundle
	o.Data.Version = b.Data.Version
	for _, x := range b.Data.Groups {
		if keep(x.Meta) {
			o.Data.Groups = append(o.Data.Groups, x)
		}
	}
	for _, x := range b.Data.Hosts {
		if keep(x.Meta) {
			o.Data.Hosts = append(o.Data.Hosts, x)
		}
	}
	for _, x := range b.Data.Forwards {
		if keep(x.Meta) {
			o.Data.Forwards = append(o.Data.Forwards, x)
		}
	}
	for _, x := range b.Data.Identities {
		if keep(x.Meta) {
			o.Data.Identities = append(o.Data.Identities, x)
		}
	}
	for _, x := range b.Data.Snippets {
		if keep(x.Meta) {
			o.Data.Snippets = append(o.Data.Snippets, x)
		}
	}
	for _, x := range b.Secrets {
		if keep(x.Meta) {
			o.Secrets = append(o.Secrets, x)
		}
	}
	return o
}
