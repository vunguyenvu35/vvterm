import {leaves, type Node, type Tab} from '../layout'
import {SftpBrowser} from '../sftp/SftpBrowser'
import {TerminalPane} from './TerminalPane'
import type {Settings} from '../types'
import {resolveTerminalTheme} from './themes'
import type {Appearance} from '../settings/appearance'

interface Props {
  tabs: Tab[]
  /** id of the visible terminal tab; '' while the home (Vaults) tab is shown */
  activeTab: string
  settings: Settings
  appearance: Appearance
  /** effective shortcut for every action (see lib/shortcuts) */
  shortcuts: Record<string, string>
  onFocusPane(tabId: string, paneId: string): void
  onPaneExit(tabId: string, paneId: string): void
  /** the user closes one pane of a split tab (the × on the pane) */
  onClosePane(tabId: string, paneId: string): void
}

/** Recursive split-pane tree per tab. Every tab stays mounted so its sessions keep running. */
export function Workspace(p: Props) {
  const termTheme = resolveTerminalTheme(p.settings.terminal_theme, p.appearance).theme
  const render = (tab: Tab, n: Node, visible: boolean): JSX.Element => {
    if (n.type === 'leaf') {
      const split = leaves(tab.root).length > 1
      return (
        <div key={n.id} className="pane-wrap">
        <TerminalPane paneId={n.id} hostId={n.hostId} visible={visible} focused={tab.activePane === n.id}
          fontSize={p.settings.font_size} fontFamily={p.settings.font_family} termTheme={termTheme} searchCombo={p.shortcuts.terminal_search}
          cursorStyle={p.settings.cursor_style} cursorBlink={p.settings.cursor_blink} scrollback={p.settings.scrollback}
          onFocus={() => p.onFocusPane(tab.id, n.id)} onExit={() => p.onPaneExit(tab.id, n.id)} />
        {split && (
          <button className="pane-close" aria-label="Close pane" title="Close pane" onClick={() => p.onClosePane(tab.id, n.id)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        )}
        </div>
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
    <div className="panes" style={{display: p.activeTab ? 'block' : 'none', background: termTheme.background}}>
      {p.tabs.map(t => (
        <div key={t.id} style={{display: t.id === p.activeTab ? 'block' : 'none', height: '100%'}}>
          {t.kind === 'sftp' ? <SftpBrowser hostId={leaves(t.root)[0].hostId} hostLabel={t.sftpLabel ?? ''} nonce={t.sftpNonce ?? 0} /> : render(t, t.root, t.id === p.activeTab)}
        </div>
      ))}
    </div>
  )
}
