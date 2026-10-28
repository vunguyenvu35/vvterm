import type {Node, Tab} from '../layout'
import {TerminalPane} from './TerminalPane'
import type {Settings} from '../types'

interface Props {
  tabs: Tab[]
  activeTab: string
  settings: Settings
  onSelect(id: string): void
  onClose(id: string): void
  onSplit(dir: 'row' | 'col'): void
  onFocusPane(tabId: string, paneId: string): void
  onPaneExit(tabId: string, paneId: string): void
}

/** Tabs plus a recursive split-pane tree. Every tab stays mounted so its sessions keep running. */
export function Workspace(p: Props) {
  const render = (tab: Tab, n: Node, visible: boolean): JSX.Element => {
    if (n.type === 'leaf') {
      return (
        <TerminalPane key={n.id} hostId={n.hostId} visible={visible} focused={tab.activePane === n.id}
          fontSize={p.settings.font_size} fontFamily={p.settings.font_family} theme={p.settings.theme}
          onFocus={() => p.onFocusPane(tab.id, n.id)} onExit={() => p.onPaneExit(tab.id, n.id)} />
      )
    }
    return (
      <div key={n.id} className={'pane-split ' + n.dir}>
        {render(tab, n.a, visible)}
        <div className="divider" />
        {render(tab, n.b, visible)}
      </div>
    )
  }

  return (
    <div className="workspace">
      <div className="tabbar" role="tablist">
        {p.tabs.map(t => (
          <div key={t.id} role="tab" aria-selected={t.id === p.activeTab} className={'tab' + (t.id === p.activeTab ? ' active' : '')} onClick={() => p.onSelect(t.id)}>
            <span>{t.title}</span>
            <span className="x" role="button" aria-label={`Close ${t.title}`} onClick={e => { e.stopPropagation(); p.onClose(t.id) }}>✕</span>
          </div>
        ))}
        <div className="tab-tools">
          <button className="icon" disabled={!p.tabs.length} title="Split right" aria-label="Split right" onClick={() => p.onSplit('row')}>◫</button>
          <button className="icon" disabled={!p.tabs.length} title="Split down" aria-label="Split down" onClick={() => p.onSplit('col')}>⬓</button>
        </div>
      </div>
      <div className="panes">
        {p.tabs.map(t => (
          <div key={t.id} style={{display: t.id === p.activeTab ? 'block' : 'none', height: '100%'}}>{render(t, t.root, t.id === p.activeTab)}</div>
        ))}
        {p.tabs.length === 0 && (
          <div className="empty"><div><h2>No open terminals</h2><div>Double-click a host in the sidebar to connect.</div></div></div>
        )}
      </div>
    </div>
  )
}
