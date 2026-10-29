import {PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState} from 'react'
import {clearHistory, getHistory, subscribeHistory} from './history'
import {TERMINAL_THEMES, resolveTerminalTheme} from './themes'
import {AssistantTab} from '../assistant/AssistantTab'
import {IconBraces, IconChevron, IconChevronDown, IconClock, IconClose, IconMinus, IconPalette, IconPlus, IconRocket, IconSearch, IconServer, IconSparkle, IconTrash} from '../ui/Icons'
import {buildTree, countHosts, countOpen, filterTree, type GroupNode} from '../hosts/tree'
import {isTerminalTab, leaves, type Tab} from '../layout'
import type {Group, Host, Settings, Snippet} from '../types'
import type {Appearance} from '../settings/appearance'

export type SidebarTab = 'hosts' | 'snippets' | 'history' | 'themes' | 'assistant'

/** The sidebar can be dragged wider or narrower; these keep both the sidebar and the terminal usable. */
export const SIDE_MIN = 260
export const SIDE_MAX = 760
export const SIDE_DEFAULT = 320
const TERMINAL_MIN = 360

export const FONT_MIN = 8
export const FONT_MAX = 32
const FONTS = ['Source Code Pro', 'JetBrains Mono', 'Fira Code', 'Menlo', 'SF Mono', 'Monaco', 'Consolas', 'Courier New', 'monospace']

interface Props {
  tab: SidebarTab
  onTab(t: SidebarTab): void
  hosts: Host[]
  /** the host groups, shown as a tree (nested through parent_id) */
  groups?: Group[]
  /** the open tabs: a host with a session open shows a dot, and a click on it switches to that tab */
  tabs?: Tab[]
  activeTab?: string
  onSelectTab?(id: string): void
  onCloseTab?(id: string): void
  snippets: Snippet[]
  settings: Settings
  appearance: Appearance
  /** type this into the focused pane; `run` presses Enter after it */
  onInsert(text: string, run: boolean): void
  onNewSnippet?(): void
  onConnect?(h: Host): void
  /** a theme or font was picked: save these settings */
  onSettings?(patch: Partial<Settings>): void
  /** the focused pane: the AI assistant reads and helps this terminal */
  paneId?: string
  /** the assistant asks the user to enable a provider */
  onOpenSettings?(): void
  /** the width the user chose (remembered by the caller) */
  width?: number
  /** the user finished dragging the edge, or reset it: remember this width */
  onWidth?(w: number): void
}

const TABS: {id: SidebarTab; label: string; icon: JSX.Element}[] = [
  {id: 'hosts', label: 'Hosts', icon: <IconRocket size={17} />},
  {id: 'snippets', label: 'Snippets', icon: <IconBraces size={17} />},
  {id: 'history', label: 'History', icon: <IconClock size={17} />},
  {id: 'themes', label: 'Themes and font', icon: <IconPalette size={17} />},
  {id: 'assistant', label: 'AI assistant', icon: <IconSparkle size={17} />},
]

/** A tiny terminal drawn in a theme's own colours. */
export function ThemeThumb({colors}: {colors: {bg: string; fg: string; green: string; blue: string; red: string}}) {
  return (
    <span className="theme-thumb" style={{background: colors.bg}} aria-hidden="true">
      <i style={{background: colors.fg, width: '80%'}} />
      <i style={{background: colors.green, width: '95%'}} />
      <i style={{background: colors.blue, width: '45%'}} />
    </span>
  )
}

/**
 * The panel on the right of a terminal, like Termius: hosts to open, snippets to run, the commands typed
 * before, and the colours and font of the terminal.
 */
export function TerminalSidebar(p: Props) {
  const [width, setWidth] = useState(p.width ?? SIDE_DEFAULT)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{x: number; w: number} | null>(null)
  useEffect(() => { setWidth(p.width ?? SIDE_DEFAULT) }, [p.width])
  const clamp = (v: number) => Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, window.innerWidth - TERMINAL_MIN, v)))
  const commit = (w: number) => { const c = clamp(w); setWidth(c); p.onWidth?.(c) }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => { if (drag.current) setWidth(clamp(drag.current.w + (drag.current.x - e.clientX))) }
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const w = clamp(drag.current.w + (drag.current.x - e.clientX))
    drag.current = null
    setDragging(false)
    commit(w)
  }
  return (
    <aside className={'term-side' + (dragging ? ' resizing' : '')} style={{width}} aria-label="Terminal sidebar">
      <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin={SIDE_MIN} aria-valuemax={SIDE_MAX} aria-valuenow={width} tabIndex={0}
        className="side-resizer" title="Drag to resize; double-click to reset"
        onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); drag.current = {x: e.clientX, w: width}; setDragging(true) }}
        onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        onDoubleClick={() => commit(SIDE_DEFAULT)}
        onKeyDown={e => {
          const step = e.shiftKey ? 64 : 16
          if (e.key === 'ArrowLeft') { e.preventDefault(); commit(width + step) } // the edge moves left: wider
          else if (e.key === 'ArrowRight') { e.preventDefault(); commit(width - step) }
          else if (e.key === 'Home') { e.preventDefault(); commit(SIDE_DEFAULT) }
        }} />
      <div className="side-tabs" role="toolbar" aria-label="Sidebar sections">
        {TABS.map(t => (
          <button key={t.id} aria-pressed={p.tab === t.id} aria-label={t.label} title={t.label}
            className={p.tab === t.id ? 'on' : ''} onClick={() => p.onTab(t.id)}>{t.icon}</button>
        ))}
      </div>
      <div className="side-body">
        {p.tab === 'hosts' && <HostsTab hosts={p.hosts} groups={p.groups ?? []} tabs={p.tabs ?? []} activeTab={p.activeTab ?? ''} onConnect={p.onConnect} onSelectTab={p.onSelectTab} onCloseTab={p.onCloseTab} />}
        {p.tab === 'snippets' && <SnippetsTab snippets={p.snippets} onInsert={p.onInsert} onNew={p.onNewSnippet} />}
        {p.tab === 'history' && <HistoryTab onInsert={p.onInsert} />}
        {p.tab === 'themes' && <ThemesTab settings={p.settings} appearance={p.appearance} onSettings={p.onSettings} />}
        {p.tab === 'assistant' && <AssistantTab paneId={p.paneId ?? ''} onOpenSettings={() => p.onOpenSettings?.()} />}
      </div>
    </aside>
  )
}

function SearchBox({value, onChange, label}: {value: string; onChange(v: string): void; label: string}) {
  return (
    <label className="side-search">
      <IconSearch size={15} />
      <input aria-label={label} placeholder="Search" value={value} onChange={e => onChange(e.target.value)} />
    </label>
  )
}

const FOLD_KEY = 'vvterm.sidebar.folded'
function loadFolded(): Set<string> {
  try { return new Set<string>(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')) } catch { return new Set() }
}

/** host id -> the terminal tabs that have a session on it (a split tab counts once per host) */
function openByHost(tabs: Tab[]): Map<string, Tab[]> {
  const m = new Map<string, Tab[]>()
  for (const t of tabs) {
    if (!isTerminalTab(t)) continue
    for (const id of new Set(leaves(t.root).map(l => l.hostId.replace(/^telnet:/, '')))) m.set(id, [...(m.get(id) ?? []), t])
  }
  return m
}

interface HostsTabProps {
  hosts: Host[]; groups: Group[]; tabs: Tab[]; activeTab: string
  onConnect?(h: Host): void; onSelectTab?(id: string): void; onCloseTab?(id: string): void
}

/**
 * Every host in its group, as a tree. A host with a session open has a dot: a click jumps to that tab
 * (again to the next one when there are several), Alt/Shift-click always opens a new one. Typing a search
 * unfolds the groups that lead to a match.
 */
function HostsTab({hosts, groups, tabs, activeTab, onConnect, onSelectTab, onCloseTab}: HostsTabProps) {
  const [q, setQ] = useState('')
  const [folded, setFolded] = useState(loadFolded)
  const searching = q.trim() !== ''
  const open = useMemo(() => openByHost(tabs), [tabs])
  const tree = useMemo(() => filterTree(buildTree(groups, hosts), q), [groups, hosts, q])
  const toggle = (id: string) => setFolded(f => {
    const n = new Set(f)
    if (!n.delete(id)) n.add(id)
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...n])) } catch { /* not remembered */ }
    return n
  })
  const pick = (h: Host, fresh: boolean) => {
    const mine = open.get(h.id)
    if (fresh || !mine?.length) return onConnect?.(h)
    // already open: go to it; when this is one of several, go to the next
    const i = mine.findIndex(t => t.id === activeTab)
    onSelectTab?.(mine[(i + 1) % mine.length].id)
  }
  const hostRow = (h: Host, depth: number) => {
    const mine = open.get(h.id) ?? []
    return (
      <button key={h.id} role="treeitem" aria-level={depth + 1} className={'side-item tree-host' + (mine.some(t => t.id === activeTab) ? ' on' : '')}
        style={{paddingLeft: 10 + depth * 14}} onClick={e => pick(h, e.altKey || e.shiftKey)}
        title={mine.length ? `Switch to ${h.label} (Alt-click: new tab)` : `Open ${h.label} in a new tab`}>
        <span className="tree-lead">
          <IconServer size={15} />
          {h.env && <i className={'env-pip env-' + h.env} aria-label={h.env} />}
        </span>
        <span className="side-main"><b>{h.label}</b><small>{h.username ? h.username + '@' : ''}{h.hostname}</small></span>
        {mine.length > 0 && <span className="tree-live" aria-label={`${mine.length} open`}>{mine.length > 1 ? mine.length : ''}</span>}
      </button>
    )
  }
  const groupRow = (n: GroupNode, depth: number): JSX.Element => {
    const isOpen = searching || !folded.has(n.group.id)
    const live = countOpen(n, open)
    return (
      <div key={n.group.id} role="group">
        <button role="treeitem" aria-level={depth + 1} aria-expanded={isOpen} className="side-item tree-group" style={{paddingLeft: 6 + depth * 14}}
          onClick={() => toggle(n.group.id)}>
          {isOpen ? <IconChevronDown size={14} /> : <IconChevron size={14} />}
          <span className="tree-name" style={n.group.color ? {color: n.group.color} : undefined}>{n.group.name}</span>
          <small className="tree-count">{live > 0 && <b>{live}/</b>}{countHosts(n)}</small>
        </button>
        {isOpen && <>
          {n.children.map(c => groupRow(c, depth + 1))}
          {n.hosts.map(h => hostRow(h, depth + 1))}
        </>}
      </div>
    )
  }
  const active = tabs.filter(isTerminalTab)
  const hostOf = (t: Tab) => hosts.find(h => h.id === leaves(t.root)[0]?.hostId.replace(/^telnet:/, ''))
  const empty = tree.roots.length === 0 && tree.ungrouped.length === 0
  return (
    <>
      <SearchBox value={q} onChange={setQ} label="Search hosts in the sidebar" />
      {active.length > 0 && !searching && (
        <div className="side-list tree-active" role="list" aria-label="Active sessions">
          <h4 className="side-sub">Active <small>{active.length}</small></h4>
          {active.map(t => {
            const h = hostOf(t)
            return (
              <div key={t.id} role="listitem" className={'side-item tree-session' + (t.id === activeTab ? ' on' : '')}>
                <button className="tree-session-main" aria-label={'Switch to ' + t.title} aria-current={t.id === activeTab} onClick={() => onSelectTab?.(t.id)}>
                  <span className="tree-lead"><IconServer size={15} />{h?.env && <i className={'env-pip env-' + h.env} aria-label={h.env} />}</span>
                  <span className="side-main"><b>{t.title}</b>{h && <small>{h.hostname}</small>}</span>
                </button>
                {onCloseTab && <button className="icon ghost" aria-label={'End session ' + t.title} onClick={() => onCloseTab(t.id)}><IconClose size={13} /></button>}
              </div>
            )
          })}
        </div>
      )}
      <div className="side-list" role="tree" aria-label="Hosts">
        {tree.roots.map(n => groupRow(n, 0))}
        {tree.ungrouped.map(h => hostRow(h, 0))}
        {empty && <div className="side-empty">{hosts.length ? 'No hosts match.' : 'No hosts yet.'}</div>}
      </div>
    </>
  )
}

function SnippetsTab({snippets, onInsert, onNew}: {snippets: Snippet[]; onInsert(text: string, run: boolean): void; onNew?(): void}) {
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState<string | null>(null) // the snippet shown in full
  const shown = snippets.filter(s => `${s.label} ${s.script}`.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <>
      <div className="side-bar">
        {searching
          ? <SearchBox value={q} onChange={setQ} label="Search snippets in the sidebar" />
          : <button className="side-new" onClick={onNew}><IconBraces size={14} /> New Snippet</button>}
        <button className="icon ghost" aria-label={searching ? 'Close search' : 'Search snippets'} onClick={() => { setSearching(!searching); setQ('') }}><IconSearch size={16} /></button>
      </div>
      <div className="side-list" role="list" aria-label="Snippets">
        {shown.map(s => {
          const full = open === s.id
          return (
            <div key={s.id} role="listitem" className={'side-snippet' + (full ? ' open' : '')}>
              <div className="side-snippet-head">
                <button className="side-snippet-title" aria-expanded={full} aria-label={s.label} onClick={() => setOpen(full ? null : s.id)}>
                  <IconBraces size={13} /> <span>{s.label}</span>
                </button>
                {full && <>
                  <button className="side-act" aria-label={'Run ' + s.label} onClick={() => onInsert(s.script, true)}>Run</button>
                  <button className="side-act" aria-label={'Paste ' + s.label} onClick={() => onInsert(s.script, false)}>Paste</button>
                </>}
              </div>
              {full ? <pre className="side-snippet-code">{s.script}</pre> : <code className="side-snippet-peek" onClick={() => setOpen(s.id)}>{s.script.replace(/\s+/g, ' ')}</code>}
            </div>
          )
        })}
        {shown.length === 0 && <div className="side-empty">{snippets.length ? 'No snippets match.' : 'No snippets yet.'}</div>}
      </div>
    </>
  )
}

function HistoryTab({onInsert}: {onInsert(text: string, run: boolean): void}) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState(getHistory)
  useEffect(() => subscribeHistory(() => setItems(getHistory())), [])
  const shown = useMemo(() => items.filter(c => c.toLowerCase().includes(q.trim().toLowerCase())), [items, q])
  return (
    <>
      <div className="side-bar">
        <SearchBox value={q} onChange={setQ} label="Search history" />
        <button className="icon ghost danger" aria-label="Clear history" title="Clear history" disabled={items.length === 0} onClick={clearHistory}><IconTrash size={15} /></button>
      </div>
      <div className="side-list" role="list" aria-label="History">
        {shown.map(c => (
          <button key={c} className="side-item" onClick={() => onInsert(c, false)} onDoubleClick={() => onInsert(c, true)}
            title="Click to type it, double-click to run it">
            <span className="side-main"><span className="side-cmd">{c}</span></span>
          </button>
        ))}
        {shown.length === 0 && <div className="side-empty">{items.length ? 'Nothing matches.' : 'Commands you type will show up here.'}</div>}
      </div>
    </>
  )
}

function ThemesTab({settings, appearance, onSettings}: {settings: Settings; appearance: Appearance; onSettings?(patch: Partial<Settings>): void}) {
  const [fontOpen, setFontOpen] = useState(true)
  const size = settings.font_size || 14
  const setSize = (n: number) => onSettings?.({font_size: Math.max(FONT_MIN, Math.min(FONT_MAX, n))})
  const current = settings.terminal_theme || 'auto'
  const app = resolveTerminalTheme('auto', appearance).theme
  return (
    <>
      <button className={'side-fold' + (fontOpen ? ' open' : '')} aria-expanded={fontOpen} onClick={() => setFontOpen(!fontOpen)}>
        Font {fontOpen ? <IconChevronDown size={16} /> : <IconChevron size={16} />}
      </button>
      {fontOpen && (
        <div className="side-font">
          <input aria-label="Font family" list="term-fonts" value={settings.font_family} spellCheck={false}
            onChange={e => onSettings?.({font_family: e.target.value})} />
          <datalist id="term-fonts">{FONTS.map(f => <option key={f} value={f} />)}</datalist>
          <div className="side-size">
            <span>Text Size</span>
            <button aria-label="Smaller text" disabled={size <= FONT_MIN} onClick={() => setSize(size - 1)}><IconMinus size={15} /></button>
            <output aria-label="Text size">{size}</output>
            <button aria-label="Larger text" disabled={size >= FONT_MAX} onClick={() => setSize(size + 1)}><IconPlus size={15} /></button>
          </div>
        </div>
      )}
      <h4 className="side-sub">Themes</h4>
      <div className="side-list" role="listbox" aria-label="Themes">
        <ThemeRow id="auto" name="Match app theme" note="follows light / dark" on={current === 'auto'} colors={app} onPick={() => onSettings?.({terminal_theme: 'auto'})} />
        {TERMINAL_THEMES.map(t => (
          <ThemeRow key={t.id} id={t.id} name={t.name} note={t.dark ? 'dark' : 'light'} on={current === t.id} colors={t.theme}
            onPick={() => onSettings?.({terminal_theme: t.id})} />
        ))}
      </div>
    </>
  )
}

function ThemeRow(p: {id: string; name: string; note: string; on: boolean; colors: {background?: string; foreground?: string; green?: string; blue?: string; red?: string}; onPick(): void}) {
  const c = p.colors
  return (
    <button role="option" aria-selected={p.on} className={'side-item theme' + (p.on ? ' on' : '')} onClick={p.onPick} data-theme-id={p.id}>
      <ThemeThumb colors={{bg: c.background ?? '#000', fg: c.foreground ?? '#fff', green: c.green ?? '#0f0', blue: c.blue ?? '#00f', red: c.red ?? '#f00'}} />
      <span className="side-main"><b>{p.name}</b><small>{p.note}</small></span>
    </button>
  )
}
