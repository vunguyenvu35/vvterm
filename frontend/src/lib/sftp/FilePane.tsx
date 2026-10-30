import {DragEvent, FormEvent, MouseEvent as ReactMouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {errMsg} from '../util'
import {useConfirm} from '../ui/Confirm'
import {IconArrowUp, IconChevron, IconClose, IconPlus, IconEye, IconEyeOff, IconFile, IconFolder, IconHome, IconRefresh, IconSearch} from '../ui/Icons'
import {PermissionsDialog} from './Permissions'
import {breadcrumbs, formatBytes, formatDate, joinPath, kindOf, parentOf, validName} from './format'
import {byName, SortMenu, usePref, type SortOption} from '../ui/ListTools'
import type {RemoteEntry} from '../types'

type Sort = 'name' | 'name-desc' | 'size' | 'modified'
const SORTS: SortOption<Sort>[] = [{value: 'name', label: 'Name A–Z'}, {value: 'name-desc', label: 'Name Z–A'}, {value: 'size', label: 'Size (largest first)'}, {value: 'modified', label: 'Modified (newest first)'}]

/** What a pane needs from a file system: the Local pane backs it with this computer, the Remote pane with SFTP. */
export interface PaneFs {
  list(dir: string): Promise<RemoteEntry[]>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string, isDir: boolean): Promise<void>
  /** permission bits; absent: the menu has no Edit Permissions */
  chmod?(path: string, mode: number): Promise<void>
  /** open a file with the system's app for it */
  open?(e: RemoteEntry): Promise<void>
  /** open a file with an app the user picks */
  openWith?(e: RemoteEntry): Promise<void>
  /** open a remote file and save it back to the server every time it is saved; absent: no such menu item */
  edit?(e: RemoteEntry): Promise<void>
}

export type Side = 'local' | 'remote'
export const DRAG_TYPE = 'application/x-vvterm-entry'
/** One thing being moved: a file or a folder. */
export interface Item {path: string; name: string; is_dir: boolean}
/** Carried by a drag from one pane to the other: everything that was selected. */
export interface DragPayload {side: Side; items: Item[]}
export interface PaneState {cwd: string; selected: RemoteEntry[]}

interface Props {
  side: Side
  title: string
  icon: ReactNode
  /** null while there is nothing to browse yet (not connected) */
  fs: PaneFs | null
  startDir: string
  /** bump to re-read the current folder (after a transfer) */
  reloadKey: number
  showHiddenDefault: boolean
  /** buttons in the header, e.g. the transfer button */
  actions?: ReactNode
  onState(s: PaneState): void
  /** something from the other pane was dropped here */
  onDropEntry(p: DragPayload): void
  /** right-click: copy what is chosen to the folder open in the other pane */
  onCopyOut?(items: Item[]): void
  copyLabel?: string
  /** the menu's Close: leave this pane's host; absent, Close is greyed out */
  onClose?(): void
  /** the + next to the host name: pick another host */
  onAdd?(): void
  /** replaces the icon, name and buttons at the left of the header (the Remote pane puts its host tabs here) */
  lead?: ReactNode
}

const label = (s: Side) => (s === 'local' ? 'Local' : 'Remote')

/**
 * One side of the SFTP screen: folder navigation, a table (name, date, size, kind), several selected rows at
 * once (Cmd/Ctrl-click, Shift-click, Cmd/Ctrl+A), new folder / rename / delete, and drag and drop of the
 * selection to the other side. It knows nothing about SSH.
 */
export function FilePane({side, title, icon, fs, startDir, reloadKey, showHiddenDefault, actions, onState, onDropEntry, onCopyOut, onClose, onAdd, lead, copyLabel = 'Copy to target directory'}: Props) {
  const confirm = useConfirm()
  const alive = useRef(true)
  const cwdRef = useRef('')
  const [cwd, setCwd] = useState('')
  const [pathText, setPathText] = useState('')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hidden, setHidden] = useState(showHiddenDefault)
  const [over, setOver] = useState(false)
  const [menu, setMenu] = useState<{x: number; y: number; right?: boolean} | null>(null)
  const [filtering, setFiltering] = useState(false)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = usePref<Sort>('vvterm.sftp.sort', SORTS.map(o => o.value), 'name')
  const [perms, setPerms] = useState<RemoteEntry | null>(null)
  const [naming, setNaming] = useState<{mode: 'mkdir' | 'rename'; value: string; err: string} | null>(null)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async (dir: string) => {
    if (!fs) return
    setLoading(true)
    setError('')
    try {
      const list = await fs.list(dir)
      if (!alive.current) return
      setEntries(list ?? [])
      setCwd(dir)
      cwdRef.current = dir
      setPathText(dir)
      setSelected([])
      setAnchor('')
    } catch (e) {
      if (alive.current) { setError(errMsg(e)); setPathText(cwdRef.current) }
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [fs])

  useEffect(() => { if (fs && startDir) void load(startDir) }, [fs, startDir, load])
  useEffect(() => { if (reloadKey > 0 && cwdRef.current) void load(cwdRef.current) }, [reloadKey, load])

  const needle = filter.trim().toLowerCase()
  const shown = useMemo(() => {
    const list = (hidden ? entries : entries.filter(e => !e.name.startsWith('.'))).filter(e => !needle || e.name.toLowerCase().includes(needle))
    const when = (e: RemoteEntry) => Date.parse(e.mod_time) || 0
    // folders stay first, whatever the order
    return [...list].sort((a, b) => Number(b.is_dir) - Number(a.is_dir) ||
      (sort === 'name-desc' ? byName(b.name, a.name) : sort === 'size' ? b.size - a.size || byName(a.name, b.name) : sort === 'modified' ? when(b) - when(a) || byName(a.name, b.name) : byName(a.name, b.name)))
  }, [entries, hidden, needle, sort])
  const chosen = useMemo(() => entries.filter(e => selected.includes(e.path)), [entries, selected])
  const sel = chosen.length === 1 ? chosen[0] : null // rename needs exactly one
  useEffect(() => { onState({cwd, selected: chosen}) }, [cwd, chosen, onState])

  const ready = !!fs && !!cwd
  const guard = async (fn: () => Promise<void>) => {
    setError('')
    try { await fn() } catch (e) { setError(errMsg(e)) }
  }

  const remove = (list: RemoteEntry[]) => guard(async () => {
    const what = list.length > 1 ? `these ${list.length} items (folders with everything in them)`
      : list[0].is_dir ? `the folder "${list[0].name}" and everything in it` : `"${list[0].name}"`
    if (!(await confirm(`Delete ${what}? This cannot be undone.`, {confirmLabel: 'Delete', danger: true}))) return
    try {
      for (const e of list) await fs!.remove(e.path, e.is_dir)
    } finally {
      await load(cwd) // some may have gone even when one failed
    }
  })

  /** click selects one; Cmd/Ctrl-click adds or removes one; Shift-click selects the range from the last click */
  const pick = (e: RemoteEntry, ev: ReactMouseEvent) => {
    if (ev.metaKey || ev.ctrlKey) {
      setSelected(s => (s.includes(e.path) ? s.filter(x => x !== e.path) : [...s, e.path]))
      setAnchor(e.path)
    } else if (ev.shiftKey && anchor) {
      const a = shown.findIndex(x => x.path === anchor), b = shown.findIndex(x => x.path === e.path)
      if (a >= 0 && b >= 0) setSelected(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.path))
    } else {
      setSelected([e.path])
      setAnchor(e.path)
    }
  }
  // the right-click menu closes on any click elsewhere, Escape, scrolling or a resize
  useEffect(() => {
    if (!menu) return
    const off = () => setMenu(null)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') off() }
    window.addEventListener('mousedown', off)
    window.addEventListener('resize', off)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('resize', off); window.removeEventListener('keydown', key) }
  }, [menu])
  const openMenu = (ev: ReactMouseEvent, entry: RemoteEntry | null) => {
    ev.preventDefault()
    ev.stopPropagation()
    if (!ready) return
    if (entry && !selected.includes(entry.path)) { setSelected([entry.path]); setAnchor(entry.path) }
    setMenu({x: Math.min(ev.clientX, window.innerWidth - 230), y: Math.min(ev.clientY, window.innerHeight - 420)})
  }
  /** the Actions button: the same menu as a right-click, hanging under the button */
  const toggleActions = (ev: ReactMouseEvent<HTMLButtonElement>) => {
    if (menu) return setMenu(null)
    const r = ev.currentTarget.getBoundingClientRect()
    setMenu({x: Math.max(8, window.innerWidth - r.right), y: r.bottom + 4, right: true})
  }
  const act = (fn: () => void | Promise<void>) => { setMenu(null); void guard(async () => { await fn() }) }
  const openEntry = (e: RemoteEntry) => (e.is_dir ? load(e.path) : fs?.open ? fs.open(e) : Promise.resolve())
  const selectAll = () => setSelected(shown.map(e => e.path))

  const submitName = (ev: FormEvent) => {
    ev.preventDefault()
    if (!naming) return
    const bad = validName(naming.value)
    if (bad) return setNaming({...naming, err: bad})
    const name = naming.value.trim()
    void guard(async () => {
      if (naming.mode === 'mkdir') await fs!.mkdir(joinPath(cwd, name))
      else if (sel) await fs!.rename(sel.path, joinPath(parentOf(sel.path), name))
      setNaming(null)
      await load(cwd)
    })
  }

  const goPath = (ev: FormEvent) => {
    ev.preventDefault()
    const p = pathText.trim() || '/'
    void load(p.startsWith('/') ? p : joinPath(cwd, p))
  }

  const dragStart = (e: DragEvent, entry: RemoteEntry) => {
    // dragging a selected row moves the whole selection; dragging another row moves just that one
    const group = selected.includes(entry.path) ? chosen : [entry]
    if (!selected.includes(entry.path)) setSelected([entry.path])
    const payload: DragPayload = {side, items: group.map(x => ({path: x.path, name: x.name, is_dir: x.is_dir}))}
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }
  const accepts = (e: DragEvent) => Array.from(e.dataTransfer.types ?? []).includes(DRAG_TYPE)
  const dragOver = (e: DragEvent) => {
    if (!ready || !accepts(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }
  const drop = (e: DragEvent) => {
    setOver(false)
    if (!ready || !accepts(e)) return
    e.preventDefault()
    try {
      const p = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as DragPayload
      if (p.side !== side && p.items?.length) onDropEntry(p) // dropping onto the pane it came from does nothing
    } catch { /* not ours */ }
  }

  return (
    <section className={'fpane' + (over ? ' drop-target' : '')} aria-label={label(side)}>
      <div className={'fpane-head' + (filtering ? ' filtering' : '')}>
        {lead ?? <>
          <span className="fpane-icon">{icon}</span>
          <b className="fpane-title">{title}</b>
          {onClose && <button className="icon ghost fpane-x" aria-label="Change host" title="Disconnect and pick another host" onClick={onClose}><IconClose size={13} /></button>}
          {onAdd && <button className="icon ghost fpane-x" aria-label="Add host" title="Connect to another host" onClick={onAdd}><IconPlus size={14} /></button>}
        </>}
        <span className="spacer" />
        {actions}
        {filtering && <input className="fpane-filter" aria-label={`${label(side)} filter`} autoFocus placeholder="Filter" value={filter} onChange={e => setFilter(e.target.value)}
          onKeyDown={ev => { if (ev.key === 'Escape') { setFilter(''); setFiltering(false) } }} />}
        <SortMenu value={sort} options={SORTS} onChange={setSort} />
        <button aria-label="Filter" aria-pressed={filtering} className={filtering ? 'on' : ''} onClick={() => { setFiltering(f => !f); setFilter('') }}><IconSearch size={15} /> Filter</button>
        <button aria-label="Actions" aria-haspopup="menu" aria-expanded={!!menu?.right} disabled={!ready} onMouseDown={ev => ev.stopPropagation()} onClick={toggleActions}>Actions <IconChevron size={12} /></button>
        <button className="icon" aria-label={hidden ? 'Hide hidden files' : 'Show hidden files'} aria-pressed={hidden} title={hidden ? 'Hide hidden files' : 'Show hidden files'} onClick={() => setHidden(h => !h)}>
          {hidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
        </button>
      </div>

      <div className="sftp-bar">
        <button className="icon" aria-label="Up one folder" disabled={!ready || cwd === '/'} onClick={() => load(parentOf(cwd))}><IconArrowUp size={16} /></button>
        <button className="icon" aria-label="Home folder" disabled={!ready} onClick={() => load(startDir)} title="Home"><IconHome size={16} /></button>
        <button className="icon" aria-label="Refresh" disabled={!ready} onClick={() => load(cwd)}><IconRefresh size={16} /></button>
        <form className="sftp-path" onSubmit={goPath}>
          <input aria-label={`${label(side)} path`} value={pathText} onChange={e => setPathText(e.target.value)} disabled={!ready} spellCheck={false} />
        </form>
      </div>

      <nav className="sftp-crumbs" aria-label={`${label(side)} folder path`}>
        {ready && breadcrumbs(cwd).map((c, i, all) => (
          <span key={c.path}>
            {i > 0 && <IconChevron size={12} />}
            {i === all.length - 1 ? <b>{c.name}</b> : <button className="link" onClick={() => load(c.path)}>{c.name}</button>}
          </span>
        ))}
        {chosen.length > 1 && <span className="sel-count" role="status">{chosen.length} selected</span>}
      </nav>

      {naming && (
        <form className="sftp-name" onSubmit={submitName}>
          <input aria-label="Name" autoFocus value={naming.value} placeholder={naming.mode === 'mkdir' ? 'New folder name' : 'New name'}
            onChange={e => setNaming({...naming, value: e.target.value, err: ''})} />
          <button className="primary" type="submit">{naming.mode === 'mkdir' ? 'Create' : 'Rename'}</button>
          <button type="button" onClick={() => setNaming(null)}>Cancel</button>
          {naming.err && <span className="error" role="alert">{naming.err}</span>}
        </form>
      )}

      <div className="sftp-table" role="table" aria-label={`${label(side)} files`} aria-multiselectable="true" aria-busy={loading}
        onDragOver={dragOver} onDragLeave={() => setOver(false)} onDrop={drop} onContextMenu={ev => openMenu(ev, null)}
        onKeyDown={ev => { if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'a') { ev.preventDefault(); selectAll() } }}>
        <div className="sftp-row head" role="row">
          <span role="columnheader">Name</span><span role="columnheader">Date Modified</span><span role="columnheader">Size</span><span role="columnheader">Kind</span>
        </div>
        {shown.map(e => (
          <div key={e.path} role="row" tabIndex={0} draggable aria-selected={selected.includes(e.path)} className={'sftp-row' + (selected.includes(e.path) ? ' selected' : '')}
            onClick={ev => pick(e, ev)} onDragStart={ev => dragStart(ev, e)} onContextMenu={ev => openMenu(ev, e)}
            onDoubleClick={() => e.is_dir && load(e.path)} onKeyDown={ev => ev.key === 'Enter' && e.is_dir && load(e.path)}>
            <span role="cell" className="name">{e.is_dir ? <IconFolder size={16} /> : <IconFile size={16} />}<span>{e.name}</span>{e.is_link && <small className="muted"> → link</small>}</span>
            <span role="cell" className="muted">{formatDate(e.mod_time)}</span>
            <span role="cell" className="muted">{e.is_dir ? '--' : formatBytes(e.size)}</span>
            <span role="cell" className="muted">{kindOf(e)}</span>
          </div>
        ))}
        {ready && !loading && shown.length === 0 && !error && <div className="empty-hint">This folder is empty.</div>}
      </div>
      {error && <div className="sftp-error error" role="alert">{error}</div>}
      {menu && (() => {
        const targets = chosen
        const one = targets.length === 1
        const entry = one ? targets[0] : null
        const none = targets.length === 0
        return (
          <div className="ctx-menu" role="menu" aria-label={menu.right ? 'Actions' : none ? 'Folder menu' : 'File menu'} style={menu.right ? {right: menu.x, top: menu.y} : {left: menu.x, top: menu.y}}
            onMouseDown={ev => ev.stopPropagation()} onContextMenu={ev => ev.preventDefault()}>
            <button role="menuitem" disabled={!entry || (!entry.is_dir && !fs?.open)} onClick={() => act(() => openEntry(entry!))}>Open</button>
            <button role="menuitem" disabled={!entry || entry.is_dir || !fs?.openWith} onClick={() => act(() => fs!.openWith!(entry!))}>Open with…</button>
            {fs?.edit && <button role="menuitem" disabled={!entry || entry.is_dir} onClick={() => act(() => fs.edit!(entry!))}>Edit and save back</button>}
            <button role="menuitem" disabled={none || !onCopyOut} onClick={() => { setMenu(null); onCopyOut?.(targets.map(x => ({path: x.path, name: x.name, is_dir: x.is_dir}))) }}>{copyLabel}</button>
            <button role="menuitem" disabled={!entry} onClick={() => { setMenu(null); setNaming({mode: 'rename', value: entry!.name, err: ''}) }}>Rename</button>
            <button role="menuitem" className="danger-item" disabled={none} onClick={() => { setMenu(null); void remove(targets) }}>Delete</button>
            <button role="menuitem" onClick={() => act(() => load(cwd))}>Refresh</button>
            <button role="menuitem" onClick={() => { setMenu(null); setNaming({mode: 'mkdir', value: '', err: ''}) }}>New Folder</button>
            <button role="menuitem" onClick={() => { setMenu(null); setHidden(h => !h) }}>{hidden ? 'Hide Hidden Files' : 'Show Hidden Files'}</button>
            <button role="menuitem" disabled={!entry || !fs?.chmod} onClick={() => { setMenu(null); setPerms(entry) }}>Edit Permissions</button>
            <button role="menuitem" disabled={shown.length === 0} onClick={() => { setMenu(null); selectAll() }}>Select All</button>
            <button role="menuitem" className="danger-item" disabled={!onClose} onClick={() => { setMenu(null); onClose?.() }}>Close</button>
          </div>
        )
      })()}
      {perms && fs?.chmod && (
        <PermissionsDialog name={perms.name} mode={perms.mode} onClose={() => setPerms(null)}
          onSave={async m => { await fs.chmod!(perms.path, m); await load(cwd) }} />
      )}
    </section>
  )
}
