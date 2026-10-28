import {OS_INFO, OsIcon, osName} from '../ui/OsIcon'
import {ReactNode, useMemo, useState} from 'react'
import type {Env, Group, Host} from '../types'
import {formatAddr} from '../util'
import {IconChevron, IconEdit, IconFolder, IconForward, IconPlay, IconSearch, IconServer, IconTrash} from '../ui/Icons'

export interface QuickConnect {
  username: string
  hostname: string
  port: number
}

interface Props {
  groups: Group[]
  hosts: Host[]
  /** Rendered between the search bar and the lists (New host / New group buttons). */
  toolbar?: ReactNode
  onConnect(h: Host): void
  onEdit(h: Host): void
  onDelete(h: Host): void
  onForwards(h: Host): void
  /** open the SFTP file browser for a host */
  onSftp?(h: Host): void
  onEditGroup(g: Group): void
  onDeleteGroup(g: Group): void
  /** Text being typed in the New host panel: shown as a highlighted draft card. `undefined` = no draft. */
  draft?: string
  /** The typed text is `[ssh ][user@]host[:port]` and matches no saved host. */
  onQuickConnect?(q: QuickConnect): void
}

const ENVS: Env[] = ['prod', 'staging', 'dev']

/** Parses "ssh user@host:2222", "user@host" or "host". */
export function parseQuickConnect(text: string): QuickConnect | null {
  const m = text.trim().replace(/^ssh\s+/i, '').match(/^(?:([^\s@]+)@)?([A-Za-z0-9_.\-[\]:]+?)(?::(\d{1,5}))?$/)
  if (!m) return null
  const port = m[3] ? Number(m[3]) : 22
  if (port < 1 || port > 65535) return null
  return {username: m[1] ?? '', hostname: m[2], port}
}

function descendants(groups: Group[], id: string): Set<string> {
  const out = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups) if (g.parent_id && out.has(g.parent_id) && !out.has(g.id)) { out.add(g.id); grew = true }
  }
  return out
}

/** Termius-style hosts page: find/connect bar, environment filter, group cards and host cards. */
export function HostList(p: Props) {
  const [q, setQ] = useState('')
  const [env, setEnv] = useState<Env>('')
  const [groupId, setGroupId] = useState('')

  const groupIds = useMemo(() => new Set(p.groups.map(g => g.id)), [p.groups])
  // a group whose id vanished (deleted elsewhere) falls back to the root
  const current = groupId && groupIds.has(groupId) ? groupId : ''
  const filtering = q.trim() !== '' || env !== ''

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^ssh\s+/, '')
    return p.hosts.filter(h => {
      if (env && h.env !== env) return false
      if (!needle) return true
      return `${h.label} ${h.hostname} ${h.username} ${h.username}@${h.hostname} ${h.username}@${h.hostname}:${h.port} ${(h.tags ?? []).join(' ')}`.toLowerCase().includes(needle)
    })
  }, [p.hosts, q, env])

  const subgroups = useMemo(
    () => p.groups.filter(g => (g.parent_id && groupIds.has(g.parent_id) ? g.parent_id : '') === current),
    [p.groups, groupIds, current])
  const visibleHosts = filtering
    ? matches
    : p.hosts.filter(h => (h.group_id && groupIds.has(h.group_id) ? h.group_id : '') === current)

  const count = (g: Group) => {
    const ids = descendants(p.groups, g.id)
    return p.hosts.filter(h => h.group_id && ids.has(h.group_id)).length
  }
  const trail = useMemo(() => {
    const out: Group[] = []
    for (let id = current, n = 0; id && n < 16; n++) {
      const g = p.groups.find(x => x.id === id)
      if (!g) break
      out.unshift(g)
      id = g.parent_id && groupIds.has(g.parent_id) ? g.parent_id : ''
    }
    return out
  }, [p.groups, groupIds, current])

  const connectFromBar = () => {
    if (matches.length === 1 && q.trim()) return p.onConnect(matches[0])
    const parsed = parseQuickConnect(q)
    if (parsed && p.onQuickConnect) p.onQuickConnect(parsed)
  }

  const hostCard = (h: Host) => (
    <div key={h.id} className="host card" role="listitem" onDoubleClick={() => p.onConnect(h)} title={`Double-click to connect to ${h.label}`}>
      {osName(h.os)
        ? (
          <span className="tile os-tile" style={{background: OS_INFO[h.os!].color}} title={`${osName(h.os)}${h.env ? ' · ' + h.env : ''}`} data-os={h.os}>
            <OsIcon os={h.os} size={22} />
            {h.env && <i className={'env-pip env-' + h.env} aria-label={h.env} />}
          </span>
        )
        : <span className={'tile env-' + (h.env || 'none')} title={h.env || 'no environment'}><IconServer size={20} /></span>}
      <div className="meta">
        <div className="label">{h.label}</div>
        <div className="addr">{h.username ? `ssh, ${h.username}` : 'ssh'} · {formatAddr({hostname: h.hostname, port: h.port})}</div>
      </div>
      {p.onSftp && <button className="sftp-chip" aria-label={`SFTP ${h.label}`} title="Browse files (SFTP)" onClick={() => p.onSftp!(h)}><IconFolder size={14} /> SFTP</button>}
      <div className="actions">
        <button className="icon ghost" aria-label={`Connect ${h.label}`} onClick={() => p.onConnect(h)}><IconPlay size={14} /></button>
        <button className="icon ghost" aria-label={`Forwards ${h.label}`} onClick={() => p.onForwards(h)}><IconForward size={14} /></button>
        <button className="icon ghost" aria-label={`Edit ${h.label}`} onClick={() => p.onEdit(h)}><IconEdit size={14} /></button>
        <button className="icon ghost danger" aria-label={`Delete ${h.label}`} onClick={() => p.onDelete(h)}><IconTrash size={14} /></button>
      </div>
    </div>
  )

  return (
    <div className="hosts-page">
      <div className="connect-bar">
        <IconSearch size={16} />
        <input aria-label="Search hosts" placeholder="Find a host or ssh user@hostname…" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && connectFromBar()} />
        <button className="connect-btn" disabled={!q.trim()} onClick={connectFromBar}>Connect</button>
      </div>

      <div className="toolbar">
        {p.toolbar}
        <div className="spacer" />
        <div className="chips">
          {ENVS.map(e => (
            <span key={e} role="button" aria-pressed={env === e} tabIndex={0} className={'chip' + (env === e ? ' on' : '')}
              onClick={() => setEnv(env === e ? '' : e)} onKeyDown={ev => ev.key === 'Enter' && setEnv(env === e ? '' : e)}>
              <i className={'dot env-' + e} /> {e}
            </span>
          ))}
        </div>
      </div>

      {!filtering && current && (
        <nav className="crumbs" aria-label="Group path">
          <button className="link" onClick={() => setGroupId('')}>All hosts</button>
          {trail.map((g, i) => (
            <span key={g.id}><IconChevron size={12} /> {i === trail.length - 1 ? <b>{g.name}</b> : <button className="link" onClick={() => setGroupId(g.id)}>{g.name}</button>}</span>
          ))}
        </nav>
      )}

      {!filtering && subgroups.length > 0 && (
        <>
          <h3 className="sec-title">Groups</h3>
          <div className="cards">
            {subgroups.map(g => (
              <div key={g.id} className="group card" role="button" tabIndex={0} aria-label={`Open group ${g.name}`}
                onClick={() => setGroupId(g.id)} onKeyDown={e => e.key === 'Enter' && setGroupId(g.id)}>
                <span className="tile group-tile" style={g.color ? {background: g.color} : undefined}><IconFolder size={20} /></span>
                <div className="meta">
                  <div className="label">{g.name}</div>
                  <div className="addr">{count(g)} {count(g) === 1 ? 'Host' : 'Hosts'}</div>
                </div>
                <div className="actions" onClick={e => e.stopPropagation()}>
                  <button className="icon ghost" aria-label={`Edit group ${g.name}`} onClick={() => p.onEditGroup(g)}><IconEdit size={14} /></button>
                  <button className="icon ghost danger" aria-label={`Delete group ${g.name}`} onClick={() => p.onDeleteGroup(g)}><IconTrash size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="sec-title">Hosts</h3>
      <div className="cards" role="list" aria-label="Hosts">
        {p.draft !== undefined && (
          <div className="card draft" aria-label="New host draft" data-testid="draft-card">
            <span className="tile env-none"><IconServer size={20} /></span>
            <div className="meta"><div className="label">{p.draft || 'Enter IP or Hostname…'}</div><div className="addr">ssh</div></div>
          </div>
        )}
        {visibleHosts.map(hostCard)}
      </div>
      {visibleHosts.length === 0 && p.draft === undefined && (
        <div className="empty-hint">
          {filtering ? 'No hosts match.' : current ? 'This group has no hosts yet.' : 'No hosts yet. Add one to get started.'}
        </div>
      )}
    </div>
  )
}
