import {leaves, type Node, type Tab} from '../layout'
import {SftpBrowser} from '../sftp/SftpBrowser'
import {writeToPane} from './panes'
import {formatCombo} from '../shortcuts/shortcuts'
import {OsIcon} from '../ui/OsIcon'
import {IconBroadcast, IconClose, IconMaximizePane, IconMinimizePane} from '../ui/Icons'
import {TerminalPane} from './TerminalPane'
import {NewTabScreen} from '../shell/NewTabScreen'
import {ProtocolScreen, type Protocol} from './ProtocolScreen'
import type {Group, Host, Settings} from '../types'
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
  /** the saved hosts: one with its own terminal theme overrides the one from Settings */
  hosts?: Host[]
  onFocusPane(tabId: string, paneId: string): void
  onPaneExit(tabId: string, paneId: string): void
  /** the user closes one pane of a split tab (the × on the pane) */
  onClosePane(tabId: string, paneId: string): void
  /** the Broadcast button of a pane header */
  onToggleBroadcast?(tabId: string): void
  /** the maximise button of a pane header */
  onToggleZoom?(tabId: string, paneId: string): void
  /** a tab that asked which protocol to use got its answer */
  onProtocol?(tabId: string, protocol: Protocol): void
  /** a blank tab: a host was picked, or an open tab */
  onOpenFromNewTab?(tabId: string, h: Host): void
  onSelectTab?(id: string): void
  /** a blank tab becomes a terminal on this computer */
  onLocalFromNewTab?(tabId: string): void
  groups?: Group[]
  /** close a whole tab (the Close button of the connecting / protocol screens) */
  onCloseTab?(tabId: string): void
  /** the Show logs button of the connecting screen */
  onShowLogs?(): void
}

/** Recursive split-pane tree per tab. Every tab stays mounted so its sessions keep running. */
export function Workspace(p: Props) {
  const termTheme = resolveTerminalTheme(p.settings.terminal_theme, p.appearance).theme
  // a host's own theme wins; a Telnet pane ("telnet:<id>") belongs to the same host
  const themeFor = (hostId: string) => {
    const id = hostId.startsWith('telnet:') ? hostId.slice('telnet:'.length) : hostId
    const own = p.hosts?.find(h => h.id === id)?.terminal_theme
    return own ? resolveTerminalTheme(own, p.appearance).theme : termTheme
  }
  const hostOf = (hostId: string) => p.hosts?.find(h => h.id === (hostId.startsWith('telnet:') ? hostId.slice('telnet:'.length) : hostId))
  /** the name and the small print of a pane, for its header */
  const describe = (hostId: string): {label: string; detail: string; os?: string} => {
    if (hostId === 'local') return {label: 'This computer', detail: 'local shell'}
    if (hostId.startsWith('serial:')) return {label: hostId.slice('serial:'.length).split('@')[0].replace(/^\/dev\//, ''), detail: 'serial'}
    const h = hostOf(hostId)
    if (!h) return {label: hostId, detail: ''}
    if (hostId.startsWith('telnet:')) return {label: h.label, detail: ['telnet', h.username].filter(Boolean).join(', '), os: h.os}
    return {label: h.label, detail: ['ssh', h.telnet_enabled ? 'telnet' : '', h.username].filter(Boolean).join(', '), os: h.os}
  }
  /** "SSH host:port", "Telnet host:port", "this computer" */
  const connectLine = (hostId: string) => {
    const h = hostOf(hostId)
    if (hostId === 'local') return 'local shell'
    if (!h) return hostId.startsWith('serial:') ? 'serial' : ''
    return hostId.startsWith('telnet:') ? `Telnet ${h.hostname}:${h.telnet_port || 23}` : `SSH ${h.hostname}:${h.port}`
  }
  const hint = (id: string) => (p.shortcuts[id] ? ' (' + formatCombo(p.shortcuts[id]) + ')' : '')

  const render = (tab: Tab, n: Node, visible: boolean): JSX.Element => {
    const all = leaves(tab.root)
    const many = all.length > 1
    // zoom only hides what is not on the way to the zoomed pane: nothing is unmounted, so no session ends
    const zoom = tab.zoomPane
    const hidden = (node: Node) => !!zoom && !leaves(node).some(l => l.id === zoom)
    if (n.type === 'leaf') {
      const d = describe(n.hostId)
      const index = all.findIndex(l => l.id === n.id) + 1
      return (
        <div key={n.id} className={'pane-wrap' + (tab.broadcast ? ' broadcasting' : '')} style={hidden(n) ? {display: 'none'} : undefined} data-pane={n.id}>
          <TerminalPane paneId={n.id} hostId={n.hostId} connect={{label: d.label, os: d.os, subtitle: connectLine(n.hostId)}} onShowLogs={p.onShowLogs} onCloseTab={() => p.onCloseTab?.(tab.id)} visible={visible && !hidden(n)} focused={tab.activePane === n.id}
            fontSize={p.settings.font_size} fontFamily={p.settings.font_family} termTheme={themeFor(n.hostId)} searchCombo={p.shortcuts.terminal_search}
            highlight={p.settings.highlight} copyOnSelect={p.settings.copy_on_select} rightClick={p.settings.right_click} copyCombo={p.shortcuts.terminal_copy} pasteCombo={p.shortcuts.terminal_paste}
            cursorStyle={p.settings.cursor_style} cursorBlink={p.settings.cursor_blink} scrollback={p.settings.scrollback}
            onTyped={tab.broadcast ? data => all.forEach(l => { if (l.id !== n.id) writeToPane(l.id, data) }) : undefined}
            onFocus={() => p.onFocusPane(tab.id, n.id)} onExit={() => p.onPaneExit(tab.id, n.id)} />
          {many && <div className="pane-head" role="toolbar" aria-label={'Pane ' + d.label}>
            <span className="pane-label">
              {d.os && <OsIcon os={d.os} size={14} />}
              <b>{d.label} ({index})</b>
              {d.detail && <span className="pane-detail">{d.detail}</span>}
            </span>
            <span className="spacer" />
            {(
              <>
                <button className={'pane-btn' + (tab.broadcast ? ' on' : '')} aria-pressed={!!tab.broadcast} aria-label="Broadcast input"
                  title={'Type in every pane of this tab at once' + hint('broadcast_input')} onClick={() => p.onToggleBroadcast?.(tab.id)}>
                  <IconBroadcast size={14} /> Broadcast
                </button>
                <button className="pane-btn icon" aria-label={zoom === n.id ? 'Show all panes' : 'Maximize pane'} aria-pressed={zoom === n.id}
                  title={zoom === n.id ? 'Show all panes' : 'Show only this pane'} onClick={() => p.onToggleZoom?.(tab.id, n.id)}>
                  {zoom === n.id ? <IconMinimizePane size={14} /> : <IconMaximizePane size={14} />}
                </button>
                <button className="pane-btn icon" aria-label="Close pane" title="Close pane" onClick={() => p.onClosePane(tab.id, n.id)}><IconClose size={14} /></button>
              </>
            )}
          </div>}
        </div>
      )
    }
    return (
      <div key={n.id} className={'pane-split ' + n.dir} style={hidden(n) ? {display: 'none'} : undefined}>
        {render(tab, n.a, visible)}
        <div className="divider" style={zoom ? {display: 'none'} : undefined} />
        {render(tab, n.b, visible)}
      </div>
    )
  }

  return (
    <div className="panes" style={{display: p.activeTab ? 'block' : 'none', background: termTheme.background}}>
      {p.tabs.map(t => (
        <div key={t.id} style={{display: t.id === p.activeTab ? 'block' : 'none', height: '100%'}}>
          {t.kind === 'new' ? <NewTabScreen hosts={p.hosts ?? []} groups={p.groups ?? []} tabs={p.tabs} onOpen={h => p.onOpenFromNewTab?.(t.id, h)} onSelectTab={id => p.onSelectTab?.(id)} onLocal={p.onLocalFromNewTab ? () => p.onLocalFromNewTab!(t.id) : undefined} /> : t.choose && hostOf(leaves(t.root)[0].hostId) ? <ProtocolScreen host={hostOf(leaves(t.root)[0].hostId)!} onContinue={proto => p.onProtocol?.(t.id, proto)} onClose={() => p.onCloseTab?.(t.id)} /> : t.kind === 'sftp' ? <SftpBrowser hostId={leaves(t.root)[0].hostId} hostLabel={t.sftpLabel ?? ''} nonce={t.sftpNonce ?? 0} hosts={p.hosts} /> : render(t, t.root, t.id === p.activeTab)}
        </div>
      ))}
    </div>
  )
}
