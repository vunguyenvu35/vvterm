package importer

import (
	"fmt"

	"vvterm/internal/domain"
)

// Policy decides what happens when an imported host label already exists.
type Policy string

const (
	PolicySkip      Policy = "skip"
	PolicyOverwrite Policy = "overwrite"
	PolicyDuplicate Policy = "duplicate"
)

// Plan is the set of records to write; the caller stores them and imports KeyFiles into the vault.
type Plan struct {
	Groups   []domain.Group
	Hosts    []domain.Host
	Forwards []domain.PortForward
	// KeyFiles maps a planned host id to its IdentityFile path.
	KeyFiles map[string]string
	Skipped  []string
	Warnings []string
}

// Build converts parsed entries to records, resolving groups, jump hosts and conflicts
// against existing data.
func Build(p *Parsed, existing domain.Data, policy Policy) Plan {
	if policy == "" {
		policy = PolicySkip
	}
	plan := Plan{KeyFiles: map[string]string{}, Warnings: append([]string(nil), p.Warnings...)}

	groups := map[string]string{} // name -> id
	for _, g := range existing.Groups {
		if !g.Deleted() {
			groups[g.Name] = g.ID
		}
	}
	existingHost := map[string]domain.Host{} // label -> host
	for _, h := range existing.Hosts {
		if !h.Deleted() {
			existingHost[h.Label] = h
		}
	}

	byAlias := map[string]string{} // alias -> planned id
	labelUsed := map[string]bool{}
	type pending struct {
		e    Entry
		id   string
		orig string
	}
	var todo []pending

	for _, e := range p.Entries {
		label := e.Alias
		id := domain.NewID()
		if old, ok := existingHost[label]; ok {
			switch policy {
			case PolicySkip:
				plan.Skipped = append(plan.Skipped, label)
				byAlias[e.Alias] = old.ID
				continue
			case PolicyOverwrite:
				id = old.ID
			case PolicyDuplicate:
				for n := 2; ; n++ {
					c := fmt.Sprintf("%s (%d)", e.Alias, n)
					if _, taken := existingHost[c]; !taken && !labelUsed[c] {
						label = c
						break
					}
				}
			}
		}
		labelUsed[label] = true
		byAlias[e.Alias] = id
		orig := e.Alias
		e.Alias = label
		todo = append(todo, pending{e, id, orig})
	}
	// Re-map aliases that changed label so jump lookups by original alias keep working.
	for _, t := range todo {
		e := t.e
		host := domain.Host{
			Meta:     domain.Meta{ID: t.id},
			Label:    e.Alias,
			Hostname: firstNonEmpty(e.HostName, t.orig),
			Port:     defaultInt(e.Port, 22),
			Username: e.User,
			Env:      validEnv(e.Env),
			Tags:     e.Tags,
		}
		if g := e.Source; g != "" && g != "config" {
			gid, ok := groups[g]
			if !ok {
				gid = domain.NewID()
				groups[g] = gid
				plan.Groups = append(plan.Groups, domain.Group{Meta: domain.Meta{ID: gid}, Name: g})
			}
			host.GroupID = gid
		}
		if e.IdentityFile != "" {
			plan.KeyFiles[t.id] = e.IdentityFile
		}
		plan.Hosts = append(plan.Hosts, host)

		addFwd := func(typ domain.ForwardType, f Fwd) {
			pf := domain.PortForward{Meta: domain.Meta{ID: domain.NewID()}, HostID: t.id, Type: typ,
				BindAddr: f.BindAddr, BindPort: f.BindPort, DestHost: f.DestHost, DestPort: f.DestPort}
			if pf.BindAddr == "" || pf.BindAddr == "localhost" {
				pf.BindAddr = "127.0.0.1"
			}
			if pf.BindAddr == "*" {
				pf.BindAddr = "0.0.0.0"
			}
			if !domain.IsLoopback(pf.BindAddr) {
				pf.AllowPublicBind = true
				plan.Warnings = append(plan.Warnings, fmt.Sprintf("%s: forward binds %s (explicit in config)", host.Label, pf.BindAddr))
			}
			plan.Forwards = append(plan.Forwards, pf)
		}
		for _, f := range e.Local {
			addFwd(domain.ForwardLocal, f)
		}
		for _, f := range e.Remote {
			addFwd(domain.ForwardRemote, f)
		}
		for _, f := range e.Dynamic {
			addFwd(domain.ForwardDynamic, f)
		}
	}
	// Second pass: ProxyJump a,b -> target jumps via b, b jumps via a.
	idx := map[string]int{}
	for i, h := range plan.Hosts {
		idx[h.ID] = i
	}
	for _, t := range todo {
		prev := ""
		for _, j := range t.e.ProxyJump {
			jid, ok := byAlias[j]
			if !ok {
				user, hn, port := ParseJumpSpec(j)
				if h, found := existingHost[hn]; found {
					jid = h.ID
				} else {
					jh := domain.Host{Meta: domain.Meta{ID: domain.NewID()}, Label: j, Hostname: hn, Port: port, Username: user}
					plan.Hosts = append(plan.Hosts, jh)
					idx[jh.ID] = len(plan.Hosts) - 1
					byAlias[j] = jh.ID
					jid = jh.ID
				}
			}
			if prev != "" {
				if i, planned := idx[jid]; planned && plan.Hosts[i].JumpHostID == "" && jid != prev {
					plan.Hosts[i].JumpHostID = prev
				}
			}
			prev = jid
		}
		if prev != "" && prev != t.id {
			plan.Hosts[idx[t.id]].JumpHostID = prev
		}
	}
	return plan
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func defaultInt(v, d int) int {
	if v == 0 {
		return d
	}
	return v
}

func validEnv(s string) domain.Env {
	switch domain.Env(s) {
	case domain.EnvDev, domain.EnvStaging, domain.EnvProd:
		return domain.Env(s)
	}
	return ""
}
