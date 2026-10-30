import {useEffect, useState} from 'react'
import {IconClose, IconFolder, IconGear, IconKey, IconPlus, IconSidebar, IconSplitH, IconSplitV} from '../ui/Icons'
import {draggingPane, isTerminalTab, PANE_DRAG, setDraggingPane, setDraggingTab, TAB_DRAG, type Tab} from '../layout'
import {TabStatus} from './TabStatus'
import {OS_INFO, OsIcon} from '../ui/OsIcon'
import {leaves} from '../layout'
import {SnippetPicker} from '../snippets/SnippetPicker'
import type {Host, Snippet} from '../types'

interface Props {
  tabs: Tab[]
  active: string // 'home' or a tab id
  onHome(): void
  onSelect(id: string): void
  onClose(id: string): void
  onNew(): void
  onSplit(dir: 'row' | 'col'): void
  onSettings(): void
  /** a double click on an empty part of the title bar zooms the window, like any Mac app */
  onToggleMaximise?(): void
  /** a tab was given a new name (double-click its title) */
  onRename?(id: string, name: string): void
  /** right-click menu: a new tab on the same host, next to this one */
  onDuplicate?(id: string): void
  /** right-click menu: a new native window with a new session to the same place */
  onDuplicateWindow?(id: string): void
  /** right-click menu: split the tab's focused pane */
  onSplitTab?(id: string, dir: 'row' | 'col'): void
  /** the saved hosts: a tab shows the icon of the server type (Ubuntu, Debian…) it is connected to */
  hosts?: Host[]
  /** a tab was dragged to another place: before `targetId`, or after it */
  onMoveTab?(id: string, targetId: string, after: boolean): void
  /** a pane header was dropped on the tab bar: the pane becomes a tab of its own */
  onPaneOut?(tabId: string, paneId: string): void
  /** a pane header was dropped on another terminal tab: the pane joins that tab */
  onPaneToTab?(fromTabId: string, paneId: string, targetTabId: string): void
  snippets: Snippet[]
  onRunSnippet(s: Snippet, execute: boolean): void
  /** the panel on the right of a terminal (hosts, snippets, history, themes) */
  sidebarOpen?: boolean
  onToggleSidebar?(): void
  /** a newer release exists (version number): shows an Update chip in the corner */
  updateVersion?: string
  onUpdate?(): void
}

/** Title bar with the Vaults (home) tab, one tab per terminal, and split controls. */
export function TopBar(p: Props) {
  // a tab being dragged, and the tab it is over (with the side the drop would land on)
  const [dragId, setDragId] = useState('')
  const [over, setOver] = useState<{id: string; after: boolean} | null>(null)
  // a pane header dragged over the bar (to become a tab) or over a terminal tab (to join it)
  const [paneOver, setPaneOver] = useState(false)
  const [paneTab, setPaneTab] = useState('')
  const paneDragging = () => (p.onPaneOut ? draggingPane() : null)
  const hasPane = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(PANE_DRAG)
  const endPaneDrag = () => { setPaneOver(false); setPaneTab(''); setDraggingPane(null) }
  const [editing, setEditing] = useState<{id: string; value: string} | null>(null)
  const [menu, setMenu] = useState<{id: string; x: number; y: number} | null>(null)
  // the menu goes away on any click, Esc, or when the window loses focus
  useEffect(() => {
    if (!menu) return
    const off = () => setMenu(null)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); off() } }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc, true)
    window.addEventListener('blur', off)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc, true); window.removeEventListener('blur', off) }
  }, [menu])
  const menuTab = menu ? p.tabs.find(t => t.id === menu.id) : undefined
  const commit = () => {
    if (editing) p.onRename?.(editing.id, editing.value)
    setEditing(null)
  }
  const current = p.tabs.find(t => t.id === p.active)
  /** the icon of a tab: the server type of its host, a plug for a serial port, a terminal for this computer */
  const tabIcon = (t: Tab) => {
    if (t.kind === 'sftp') return <IconFolder size={15} />
    if (t.kind === 'new') return <IconPlus size={15} />
    const hostId = leaves(t.root)[0]?.hostId ?? ''
    const id = hostId.startsWith('telnet:') ? hostId.slice('telnet:'.length) : hostId
    const os = p.hosts?.find(h => h.id === id)?.os
    if (os && OS_INFO[os]) return <span className="tab-os" style={{background: OS_INFO[os].color}} data-os={os}><OsIcon os={os} size={12} /></span>
    return <IconTerminal />
  }
  const inTerminal = !!current && isTerminalTab(current)
  return (
    <div className={'topbar' + (paneOver ? ' pane-drop' : '')} role="tablist" aria-label="Open tabs" onDoubleClick={e => {
      if (!(e.target as HTMLElement).closest('.tab, button, .top-tools, .snippet-picker, [role="menu"]')) p.onToggleMaximise?.()
    }}
      onDragOver={e => { if (paneDragging() && hasPane(e)) { e.preventDefault(); setPaneOver(true) } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) { setPaneOver(false); setPaneTab('') } }}
      onDrop={e => {
        const dp = paneDragging()
        if (!dp || !hasPane(e)) return
        e.preventDefault()
        endPaneDrag()
        p.onPaneOut?.(dp.tabId, dp.paneId)
      }}>
      <div className="traffic-space" />
      <button role="tab" aria-selected={p.active === 'home'} className={'tab tab-home' + (p.active === 'home' ? ' active' : '')} onClick={p.onHome}>
        <IconKey size={15} /> <span>Vaults</span>
      </button>
      {p.tabs.map(t => (
        <div key={t.id} role="tab" aria-selected={t.id === p.active} className={'tab' + (t.pinned ? ' pinned' : '') + (t.id === p.active ? ' active' : '') + (dragId === t.id ? ' dragging' : '') + (paneTab === t.id ? ' drop-into' : '') + (over?.id === t.id && dragId !== t.id ? (over.after ? ' drop-after' : ' drop-before') : '')} onClick={() => p.onSelect(t.id)}
          draggable={!t.pinned && !!p.onMoveTab && editing?.id !== t.id}
          onDragStart={e => { setDragId(t.id); setDraggingTab(t.id); e.dataTransfer.setData(TAB_DRAG, t.id); e.dataTransfer.effectAllowed = 'move' }}
          onDragEnd={() => { setDragId(''); setDraggingTab(''); setOver(null) }}
          onDragOver={e => {
            const dp = paneDragging()
            if (dp && hasPane(e) && p.onPaneToTab && isTerminalTab(t) && dp.tabId !== t.id) { e.preventDefault(); e.stopPropagation(); setPaneOver(false); setPaneTab(t.id); return }
            if (!dragId || dragId === t.id || !Array.from(e.dataTransfer.types).includes(TAB_DRAG)) return
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            setOver({id: t.id, after: e.clientX > r.left + r.width / 2})
          }}
          onDragLeave={() => setOver(o => (o?.id === t.id ? null : o))}
          onDrop={e => {
            const dp = paneDragging()
            if (dp && hasPane(e) && p.onPaneToTab && isTerminalTab(t) && dp.tabId !== t.id) { e.preventDefault(); e.stopPropagation(); endPaneDrag(); p.onPaneToTab(dp.tabId, dp.paneId, t.id); return }
            const id = e.dataTransfer.getData(TAB_DRAG)
            if (!id || id === t.id) return
            e.preventDefault()
            const after = e.clientX > e.currentTarget.getBoundingClientRect().left + e.currentTarget.getBoundingClientRect().width / 2
            setDragId('')
            setOver(null)
            p.onMoveTab?.(id, t.id, after)
          }}
          onContextMenu={e => { e.preventDefault(); if (!t.pinned) setMenu({id: t.id, x: e.clientX, y: e.clientY}) }}>
          <span className="tab-ico">{tabIcon(t)}<TabStatus tab={t} /></span>
          {editing?.id === t.id ? (
            <input className="tab-rename" aria-label="Tab name" autoFocus value={editing.value} maxLength={60}
              onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onChange={e => setEditing({id: t.id, value: e.target.value})}
              onFocus={e => e.currentTarget.select()} onBlur={commit}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEditing(null) }} />
          ) : (
            <span className="tab-title" title={t.pinned ? t.title : t.title + ' (double-click to rename)'} onDoubleClick={() => { if (!t.pinned && p.onRename) setEditing({id: t.id, value: t.title}) }}>{t.title}</span>
          )}
          {!t.pinned && (
            <span className="x" role="button" aria-label={`Close ${t.title}`} onClick={e => { e.stopPropagation(); p.onClose(t.id) }}>
              <IconClose size={13} />
            </span>
          )}
        </div>
      ))}
      {menu && menuTab && (
        <div className="ctx-menu" role="menu" aria-label={'Tab ' + menuTab.title} style={{left: menu.x, top: menu.y}} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
          <button role="menuitem" disabled={!isTerminalTab(menuTab) || !p.onDuplicate} onClick={() => { setMenu(null); p.onDuplicate?.(menuTab.id) }}>Duplicate</button>
          <button role="menuitem" disabled={!isTerminalTab(menuTab) || !p.onDuplicateWindow} onClick={() => { setMenu(null); p.onDuplicateWindow?.(menuTab.id) }}>Duplicate in new window</button>
          <button role="menuitem" disabled={!p.onRename} onClick={() => { setMenu(null); setEditing({id: menuTab.id, value: menuTab.title}) }}>Rename</button>
          <button role="menuitem" disabled={!isTerminalTab(menuTab) || !p.onSplitTab} onClick={() => { setMenu(null); p.onSplitTab?.(menuTab.id, 'row') }}>Split right</button>
          <button role="menuitem" disabled={!isTerminalTab(menuTab) || !p.onSplitTab} onClick={() => { setMenu(null); p.onSplitTab?.(menuTab.id, 'col') }}>Split down</button>
          <div className="ctx-sep" role="separator" />
          <button role="menuitem" onClick={() => { setMenu(null); p.onClose(menuTab.id) }}>Close</button>
        </div>
      )}
      <button className="tab add" aria-label="New connection" title="New connection" onClick={p.onNew}><IconPlus size={16} /></button>
      <div className="spacer" />
      <div className="top-tools">
        {p.updateVersion && <button className="update-chip" title={`Version ${p.updateVersion} is available`} aria-label={`Update available: version ${p.updateVersion}`} onClick={p.onUpdate}>Update</button>}
        <SnippetPicker snippets={p.snippets} disabled={!inTerminal} onRun={p.onRunSnippet} />
        <button className="icon" title="Settings (⌘/Ctrl + ,)" aria-label="Open settings" onClick={p.onSettings}><IconGear /></button>
        <button className="icon" disabled={!inTerminal} title="Split right" aria-label="Split right" onClick={() => p.onSplit('row')}><IconSplitH /></button>
        <button className="icon" disabled={!inTerminal} title="Split down" aria-label="Split down" onClick={() => p.onSplit('col')}><IconSplitV /></button>
        {p.onToggleSidebar && <button className={'icon' + (p.sidebarOpen ? ' on' : '')} disabled={!inTerminal} title={p.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} aria-label="Toggle sidebar" aria-pressed={!!p.sidebarOpen} onClick={p.onToggleSidebar}><IconSidebar /></button>}
      </div>
    </div>
  )
}

function IconTerminal() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  )
}
