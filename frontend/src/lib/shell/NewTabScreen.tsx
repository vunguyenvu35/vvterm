import {useEffect, useMemo, useRef, useState} from 'react'
import {OsIcon} from '../ui/OsIcon'
import {IconServer, IconSearch, IconTerminal} from '../ui/Icons'
import {formatCombo} from '../shortcuts/shortcuts'
import {getRecent} from '../hosts/recent'
import type {Tab} from '../layout'
import type {Group, Host} from '../types'

interface Props {
  hosts: Host[]
  groups: Group[]
  /** the open tabs, searchable too */
  tabs: Tab[]
  /** a host was picked: this tab becomes a connection to it */
  onOpen(h: Host): void
  /** an open tab was picked */
  onSelectTab(id: string): void
  /** a terminal on this computer */
  onLocal?(): void
}

type Row = {key: string; label: string; os?: string; where: string; pick(): void; tab?: boolean; local?: boolean}

/**
 * What a new tab shows (like Termius): a search box for hosts and open tabs, and the connections used
 * most recently. Enter opens the highlighted row.
 */
export function NewTabScreen({hosts, groups, tabs, onOpen, onSelectTab, onLocal}: Props) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  // Cmd/Ctrl+K jumps to the search box
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const path = (h: Host) => {
    const names: string[] = []
    for (let id = h.group_id, n = 0; id && n < 16; n++) {
      const g = groups.find(x => x.id === id)
      if (!g) break
      names.unshift(g.name)
      id = g.parent_id ?? ''
    }
    return names.length ? names.join(' / ') : 'No group'
  }

  const rows: Row[] = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const hostRow = (h: Host): Row => ({key: 'h' + h.id, label: h.label, os: h.os, where: path(h), pick: () => onOpen(h)})
    const local: Row[] = onLocal ? [{key: 'local', label: 'Local Terminal', where: 'This computer', local: true, pick: onLocal}] : []
    if (!needle) {
      const recent = getRecent().map(id => hosts.find(h => h.id === id)).filter((h): h is Host => !!h)
      const list = recent.length ? recent : hosts
      return [...local, ...list.slice(0, 8).map(hostRow)]
    }
    const hs = hosts.filter(h => `${h.label} ${h.hostname} ${h.username}`.toLowerCase().includes(needle)).map(hostRow)
    const ts: Row[] = tabs.filter(t => t.kind !== 'new' && t.title.toLowerCase().includes(needle))
      .map(t => ({key: 't' + t.id, label: t.title, where: 'Open tab', tab: true, pick: () => onSelectTab(t.id)}))
    const wantsLocal = 'local terminal this computer shell'.includes(needle) || needle === 'terminal'
    return [...(wantsLocal ? local : []), ...hs, ...ts]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, hosts, groups, tabs, onLocal])

  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt(a => Math.min(rows.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(a => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') rows[Math.min(at, rows.length - 1)]?.pick()
  }

  return (
    <div className="newtab" data-testid="new-tab">
      <label className="newtab-search">
        <IconSearch size={16} />
        <input ref={input} aria-label="Search hosts or tabs" placeholder="Search hosts or tabs" value={q}
          onChange={e => { setQ(e.target.value); setAt(0) }} onKeyDown={key} />
        <kbd>{formatCombo('Mod+K')}</kbd>
      </label>
      <div className="newtab-card">
        <div className="newtab-head"><b>{q.trim() ? 'Results' : 'Recent connections'}</b></div>
        <div className="newtab-list" role="listbox" aria-label={q.trim() ? 'Results' : 'Recent connections'}>
          {rows.map((r, i) => (
            <button key={r.key} role="option" aria-selected={i === at} className={'newtab-row' + (i === at ? ' on' : '')} onClick={r.pick} onMouseEnter={() => setAt(i)}>
              {r.tab || r.local ? <span className="newtab-os"><IconTerminal size={13} /></span> : r.os ? <OsIcon os={r.os} size={20} /> : <span className="newtab-os"><IconServer size={13} /></span>}
              <span className="newtab-name">{r.label}</span>
              <span className="newtab-where">{r.where}</span>
            </button>
          ))}
          {rows.length === 0 && <div className="newtab-empty">{hosts.length ? 'Nothing matches.' : 'No hosts yet. Add one on the Vaults page.'}</div>}
        </div>
      </div>
    </div>
  )
}
