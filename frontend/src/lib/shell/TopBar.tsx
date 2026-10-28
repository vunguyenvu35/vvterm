import {useEffect, useState} from 'react'
import {IconClose, IconFolder, IconGear, IconKey, IconPlus, IconSidebar, IconSplitH, IconSplitV} from '../ui/Icons'
import type {Tab} from '../layout'
import {SnippetPicker} from '../snippets/SnippetPicker'
import type {Snippet} from '../types'

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
  snippets: Snippet[]
  onRunSnippet(s: Snippet, execute: boolean): void
  /** the panel on the right of a terminal (hosts, snippets, history, themes) */
  sidebarOpen?: boolean
  onToggleSidebar?(): void
}

/** Title bar with the Vaults (home) tab, one tab per terminal, and split controls. */
export function TopBar(p: Props) {
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
  const inTerminal = !!current && current.kind !== 'sftp'
  return (
    <div className="topbar" role="tablist" aria-label="Open tabs" onDoubleClick={e => {
      if (!(e.target as HTMLElement).closest('.tab, button, .top-tools, .snippet-picker, [role="menu"]')) p.onToggleMaximise?.()
    }}>
      <div className="traffic-space" />
      <button role="tab" aria-selected={p.active === 'home'} className={'tab tab-home' + (p.active === 'home' ? ' active' : '')} onClick={p.onHome}>
        <IconKey size={15} /> <span>Vaults</span>
      </button>
      {p.tabs.map(t => (
        <div key={t.id} role="tab" aria-selected={t.id === p.active} className={'tab' + (t.id === p.active ? ' active' : '')} onClick={() => p.onSelect(t.id)}
          onContextMenu={e => { e.preventDefault(); if (!t.pinned) setMenu({id: t.id, x: e.clientX, y: e.clientY}) }}>
          {t.kind === 'sftp' ? <IconFolder size={15} /> : <IconTerminal />}
          {editing?.id === t.id ? (
            <input className="tab-rename" aria-label="Tab name" autoFocus value={editing.value} maxLength={60}
              onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onChange={e => setEditing({id: t.id, value: e.target.value})}
              onFocus={e => e.currentTarget.select()} onBlur={commit}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEditing(null) }} />
          ) : (
            <span className="tab-title" title={t.pinned ? undefined : 'Double-click to rename'} onDoubleClick={() => { if (!t.pinned && p.onRename) setEditing({id: t.id, value: t.title}) }}>{t.title}</span>
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
          <button role="menuitem" disabled={menuTab.kind === 'sftp' || !p.onDuplicate} onClick={() => { setMenu(null); p.onDuplicate?.(menuTab.id) }}>Duplicate</button>
          <button role="menuitem" disabled={menuTab.kind === 'sftp' || !p.onDuplicateWindow} onClick={() => { setMenu(null); p.onDuplicateWindow?.(menuTab.id) }}>Duplicate in new window</button>
          <button role="menuitem" disabled={!p.onRename} onClick={() => { setMenu(null); setEditing({id: menuTab.id, value: menuTab.title}) }}>Rename</button>
          <button role="menuitem" disabled={menuTab.kind === 'sftp' || !p.onSplitTab} onClick={() => { setMenu(null); p.onSplitTab?.(menuTab.id, 'row') }}>Split right</button>
          <button role="menuitem" disabled={menuTab.kind === 'sftp' || !p.onSplitTab} onClick={() => { setMenu(null); p.onSplitTab?.(menuTab.id, 'col') }}>Split down</button>
          <div className="ctx-sep" role="separator" />
          <button role="menuitem" onClick={() => { setMenu(null); p.onClose(menuTab.id) }}>Close</button>
        </div>
      )}
      <button className="tab add" aria-label="New connection" title="New connection" onClick={p.onNew}><IconPlus size={16} /></button>
      <div className="spacer" />
      <div className="top-tools">
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
