import {IconClose, IconFolder, IconGear, IconKey, IconPlus, IconSplitH, IconSplitV} from '../ui/Icons'
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
  snippets: Snippet[]
  onRunSnippet(s: Snippet, execute: boolean): void
}

/** Title bar with the Vaults (home) tab, one tab per terminal, and split controls. */
export function TopBar(p: Props) {
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
        <div key={t.id} role="tab" aria-selected={t.id === p.active} className={'tab' + (t.id === p.active ? ' active' : '')} onClick={() => p.onSelect(t.id)}>
          {t.kind === 'sftp' ? <IconFolder size={15} /> : <IconTerminal />}
          <span className="tab-title">{t.title}</span>
          {!t.pinned && (
            <span className="x" role="button" aria-label={`Close ${t.title}`} onClick={e => { e.stopPropagation(); p.onClose(t.id) }}>
              <IconClose size={13} />
            </span>
          )}
        </div>
      ))}
      <button className="tab add" aria-label="New connection" title="New connection" onClick={p.onNew}><IconPlus size={16} /></button>
      <div className="spacer" />
      <div className="top-tools">
        <SnippetPicker snippets={p.snippets} disabled={!inTerminal} onRun={p.onRunSnippet} />
        <button className="icon" title="Settings (⌘/Ctrl + ,)" aria-label="Open settings" onClick={p.onSettings}><IconGear /></button>
        <button className="icon" disabled={!inTerminal} title="Split right" aria-label="Split right" onClick={() => p.onSplit('row')}><IconSplitH /></button>
        <button className="icon" disabled={!inTerminal} title="Split down" aria-label="Split down" onClick={() => p.onSplit('col')}><IconSplitV /></button>
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
