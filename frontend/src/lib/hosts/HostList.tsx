import {useMemo, useState} from 'react'
import type {Env, Group, Host} from '../types'
import {buildTree, countHosts, GroupNode} from './tree'
import {envColor, formatAddr} from '../util'

interface Props {
  groups: Group[]
  hosts: Host[]
  onConnect(h: Host): void
  onEdit(h: Host): void
  onDelete(h: Host): void
  onForwards(h: Host): void
  onEditGroup(g: Group): void
  onDeleteGroup(g: Group): void
}

const ENVS: Env[] = ['prod', 'staging', 'dev']

/** Searchable, env-filterable tree of groups and hosts. Filtering is client side over the loaded list. */
export function HostList(p: Props) {
  const [q, setQ] = useState('')
  const [env, setEnv] = useState<Env>('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return p.hosts.filter(h => {
      if (env && h.env !== env) return false
      if (!needle) return true
      return `${h.label} ${h.hostname} ${h.username} ${(h.tags ?? []).join(' ')}`.toLowerCase().includes(needle)
    })
  }, [p.hosts, q, env])

  const tree = useMemo(() => buildTree(p.groups, shown), [p.groups, shown])
  const filtering = q.trim() !== '' || env !== ''

  const hostRow = (h: Host) => (
    <div key={h.id} className="host" role="listitem" onDoubleClick={() => p.onConnect(h)} title={`Double-click to connect to ${h.label}`}>
      <span className="dot" style={{background: envColor(h.env)}} title={h.env || 'no environment'} />
      <div className="meta">
        <div className="label">{h.label}</div>
        <div className="addr">{formatAddr(h)}</div>
      </div>
      <div className="actions">
        <button className="icon ghost" aria-label={`Connect ${h.label}`} onClick={() => p.onConnect(h)}>▶</button>
        <button className="icon ghost" aria-label={`Forwards ${h.label}`} onClick={() => p.onForwards(h)}>⇄</button>
        <button className="icon ghost" aria-label={`Edit ${h.label}`} onClick={() => p.onEdit(h)}>✎</button>
        <button className="icon ghost danger" aria-label={`Delete ${h.label}`} onClick={() => p.onDelete(h)}>🗑</button>
      </div>
    </div>
  )

  const groupNode = (n: GroupNode, depth: number): JSX.Element | null => {
    const total = countHosts(n)
    if (filtering && total === 0) return null
    const open = !collapsed[n.group.id]
    return (
      <div key={n.group.id} style={{marginLeft: depth * 8}}>
        <div className="group-title" onClick={() => setCollapsed(c => ({...c, [n.group.id]: open}))}>
          <span>{open ? '▾' : '▸'}</span>
          <span style={{color: n.group.color || undefined}}>{n.group.name}</span>
          <span className="badge">{total}</span>
          <span className="actions" onClick={e => e.stopPropagation()}>
            <button className="icon ghost" aria-label={`Edit group ${n.group.name}`} onClick={() => p.onEditGroup(n.group)}>✎</button>
            <button className="icon ghost danger" aria-label={`Delete group ${n.group.name}`} onClick={() => p.onDeleteGroup(n.group)}>🗑</button>
          </span>
        </div>
        {open && (
          <>
            {n.children.map(c => groupNode(c, depth + 1))}
            {n.hosts.map(hostRow)}
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="sidebar-search">
        <input aria-label="Search hosts" placeholder="Search hosts, tags…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="chips">
          {ENVS.map(e => (
            <span key={e} role="button" aria-pressed={env === e} className={'chip' + (env === e ? ' on' : '')} onClick={() => setEnv(env === e ? '' : e)}>
              <span style={{color: envColor(e)}}>●</span> {e}
            </span>
          ))}
        </div>
      </div>
      <div className="tree" role="list" aria-label="Hosts">
        {tree.roots.map(r => groupNode(r, 0))}
        {tree.ungrouped.map(hostRow)}
        {shown.length === 0 && <div className="muted" style={{padding: 12}}>{filtering ? 'No hosts match.' : 'No hosts yet. Add one to get started.'}</div>}
      </div>
    </>
  )
}
