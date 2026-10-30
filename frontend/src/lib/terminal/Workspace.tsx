import {draggingPane, draggingTab, isTerminalTab, leaves, PANE_DRAG, paneRects, setDraggingPane, sideOf, TAB_DRAG, type DropSide, type Rect, type Tab} from '../layout'
import {useState} from 'react'
import {SftpBrowser} from '../sftp/SftpBrowser'
import {writeToPane} from './panes'
import {formatCombo} from '../shortcuts/shortcuts'
import {OsIcon} from '../ui/OsIcon'
import {IconBroadcast, IconClose, IconGrip, IconMaximizePane, IconMinimizePane, IconPopOut} from '../ui/Icons'
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
  /** the button of a pane header that takes the pane out of its split into a tab of its own */
  onPopPane?(tabId: string, paneId: string): void
  /** a tab was dropped on a side of a pane: split the pane there */
  onDropTab?(targetTabId: string, paneId: string, sourceTabId: string, side: DropSide): void
  /** a pane, dragged by its header, was dropped on a side of another pane (of this tab or of another one) */
  onMovePane?(fromTabId: string, paneId: string, toTabId: string, toPaneId: string, side: DropSide): void
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
  // a tab dragged over a pane shows where the split would go
  const [dropAt, setDropAt] = useState<{pane: string; side: DropSide} | null>(null)
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

  /** One pane, placed at its box in the area. Every pane of every tab is a child of the same list, keyed by its id. */
  const pane = (tab: Tab, leaf: {id: string; hostId: string}, box: Rect, shown: boolean): JSX.Element => {
    const all = leaves(tab.root)
    const many = all.length > 1
    const zoom = tab.zoomPane
    const n = leaf
    const d = describe(n.hostId)
    const index = all.findIndex(l => l.id === n.id) + 1
    const zoomed = zoom === n.id
    const rect = zoomed ? {x: 0, y: 0, w: 100, h: 100} : box
    const hidden = !shown || (!!zoom && !zoomed)
    return (
      <div key={n.id} className={'pane-wrap' + (tab.broadcast ? ' broadcasting' : '') + (many ? ' multi' : '') + (many && tab.activePane === n.id ? ' active' : '')}
        // with several panes, the one that has the keyboard is the one with the accent frame; the others are dimmed
        data-focused={many ? String(tab.activePane === n.id) : undefined}
        style={{position: 'absolute', left: rect.x + '%', top: rect.y + '%', width: rect.w + '%', height: rect.h + '%', display: hidden ? 'none' : undefined}} data-pane={n.id}
        onDragOver={e => {
          const dp = draggingPane()
          if (dp && p.onMovePane && dp.paneId !== n.id && isTerminalTab(tab) && Array.from(e.dataTransfer.types).includes(PANE_DRAG)) {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            setDropAt({pane: n.id, side: sideOf(e.clientX - r.left, e.clientY - r.top, r.width, r.height)})
            return
          }
          const from = draggingTab()
          if (!p.onDropTab || !from || from === tab.id || !isTerminalTab(tab) || !Array.from(e.dataTransfer.types).includes(TAB_DRAG)) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setDropAt({pane: n.id, side: sideOf(e.clientX - r.left, e.clientY - r.top, r.width, r.height)})
        }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDropAt(h => (h?.pane === n.id ? null : h)) }}
        onDrop={e => {
          const r = e.currentTarget.getBoundingClientRect()
          const side = sideOf(e.clientX - r.left, e.clientY - r.top, r.width, r.height)
          setDropAt(null)
          const dp = draggingPane()
          if (dp && p.onMovePane && dp.paneId !== n.id && Array.from(e.dataTransfer.types).includes(PANE_DRAG)) {
            e.preventDefault()
            setDraggingPane(null)
            p.onMovePane(dp.tabId, dp.paneId, tab.id, n.id, side)
            return
          }
          const from = e.dataTransfer.getData(TAB_DRAG)
          if (!p.onDropTab || !from || from === tab.id) return
          e.preventDefault()
          p.onDropTab(tab.id, n.id, from, side)
        }}>
        {dropAt?.pane === n.id && <div className={'drop-hint ' + dropAt.side} aria-hidden="true" data-side={dropAt.side} />}
        <TerminalPane paneId={n.id} hostId={n.hostId} connect={{label: d.label, os: d.os, subtitle: connectLine(n.hostId)}} onShowLogs={p.onShowLogs} onCloseTab={() => p.onCloseTab?.(tab.id)} visible={!hidden} focused={tab.activePane === n.id}
          fontSize={p.settings.font_size} fontFamily={p.settings.font_family} termTheme={themeFor(n.hostId)} searchCombo={p.shortcuts.terminal_search}
          highlight={p.settings.highlight} copyOnSelect={p.settings.copy_on_select} rightClick={p.settings.right_click} copyCombo={p.shortcuts.terminal_copy} appCombos={[p.shortcuts.next_tab, p.shortcuts.prev_tab, p.shortcuts.toggle_suggest].filter(Boolean)} pasteCombo={p.shortcuts.terminal_paste}
          suggest={p.settings.suggest} suggestHost={p.settings.suggest_host} suggestCombo={p.shortcuts.suggest_popup}
          cursorStyle={p.settings.cursor_style} cursorBlink={p.settings.cursor_blink} scrollback={p.settings.scrollback}
          onTyped={tab.broadcast ? data => all.forEach(l => { if (l.id !== n.id) writeToPane(l.id, data) }) : undefined}
          onFocus={() => p.onFocusPane(tab.id, n.id)} onExit={() => p.onPaneExit(tab.id, n.id)} />
        {many && <div className="pane-head" role="toolbar" aria-label={'Pane ' + d.label}
          // the header is the handle: drag it onto a side of another pane to move the pane there, onto the tab bar to make it a tab
          draggable={!!p.onMovePane && isTerminalTab(tab)}
          onDragStart={e => { setDraggingPane({tabId: tab.id, paneId: n.id}); e.dataTransfer.setData(PANE_DRAG, n.id); e.dataTransfer.effectAllowed = 'move' }}
          onDragEnd={() => { setDraggingPane(null); setDropAt(null) }}>
          <span className="pane-grip" aria-hidden="true"><IconGrip size={14} /></span>
          <span className="pane-label">
            {d.os && <OsIcon os={d.os} size={14} />}
            <b>{d.label} ({index})</b>
            {d.detail && <span className="pane-detail">{d.detail}</span>}
          </span>
          <span className="spacer" />
          <button className={'pane-btn' + (tab.broadcast ? ' on' : '')} aria-pressed={!!tab.broadcast} aria-label="Broadcast input"
            title={'Type in every pane of this tab at once' + hint('broadcast_input')} onClick={() => p.onToggleBroadcast?.(tab.id)}>
            <IconBroadcast size={14} /> Broadcast
          </button>
          {p.onPopPane && <button className="pane-btn icon" aria-label="Move pane to its own tab" title="Move this pane out of the split, into a tab of its own" onClick={() => p.onPopPane!(tab.id, n.id)}><IconPopOut size={14} /></button>}
          <button className="pane-btn icon" aria-label={zoomed ? 'Show all panes' : 'Maximize pane'} aria-pressed={zoomed}
            title={zoomed ? 'Show all panes' : 'Show only this pane'} onClick={() => p.onToggleZoom?.(tab.id, n.id)}>
            {zoomed ? <IconMinimizePane size={14} /> : <IconMaximizePane size={14} />}
          </button>
          <button className="pane-btn icon close" aria-label="Close pane" title="Close pane" onClick={() => p.onClosePane(tab.id, n.id)}><IconClose size={14} /></button>
        </div>}
      </div>
    )
  }

  // One flat list: the panes of every tab, the dividers, and the other kinds of tab as layers. A pane that moves to
  // another place in the layout, or to another tab, keeps its key and parent, so it is not rebuilt and its session lives on.
  const items: JSX.Element[] = []
  for (const t of p.tabs) {
    const active = t.id === p.activeTab
    const layer = (node: JSX.Element) => items.push(<div key={'layer-' + t.id} className="pane-layer" style={{display: active ? 'block' : 'none'}}>{node}</div>)
    if (t.kind === 'new') {
      layer(<NewTabScreen hosts={p.hosts ?? []} groups={p.groups ?? []} tabs={p.tabs} onOpen={h => p.onOpenFromNewTab?.(t.id, h)} onSelectTab={id => p.onSelectTab?.(id)} onLocal={p.onLocalFromNewTab ? () => p.onLocalFromNewTab!(t.id) : undefined} />)
    } else if (t.choose && hostOf(leaves(t.root)[0].hostId)) {
      layer(<ProtocolScreen host={hostOf(leaves(t.root)[0].hostId)!} onContinue={proto => p.onProtocol?.(t.id, proto)} onClose={() => p.onCloseTab?.(t.id)} />)
    } else if (t.kind === 'sftp') {
      layer(<SftpBrowser hostId={leaves(t.root)[0].hostId} hostLabel={t.sftpLabel ?? ''} nonce={t.sftpNonce ?? 0} hosts={p.hosts} visible={active} />)
    } else {
      const {panes, dividers} = paneRects(t.root)
      for (const l of leaves(t.root)) items.push(pane(t, l, panes.get(l.id)!, active))
      if (!t.zoomPane) dividers.forEach((dv, k) => items.push(
        <div key={'div-' + t.id + '-' + k} className={'divider-abs ' + dv.dir} aria-hidden="true"
          style={{left: dv.x + '%', top: dv.y + '%', width: dv.dir === 'row' ? undefined : dv.w + '%', height: dv.dir === 'col' ? undefined : dv.h + '%', display: active ? undefined : 'none'}} />))
    }
  }

  return (
    <div className="panes" style={{display: p.activeTab ? 'block' : 'none', background: termTheme.background}}>
      {items}
    </div>
  )
}
