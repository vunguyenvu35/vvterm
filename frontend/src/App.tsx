import {useCallback, useEffect, useRef, useState} from 'react'
import {useBackend} from './lib/backend'
import {UnlockScreen} from './lib/vault/UnlockScreen'
import {KeychainPage, KeyMode} from './lib/vault/KeychainPage'
import {KeyPanel} from './lib/vault/KeyPanel'
import {SerialPanel, portName} from './lib/hosts/SerialPanel'
import {HostList, QuickConnect} from './lib/hosts/HostList'
import {GroupForm, HostForm} from './lib/hosts/HostForm'
import {Workspace} from './lib/terminal/Workspace'
import {ForwardPanel} from './lib/panels/ForwardPanel'
import {AddMenu} from './lib/hosts/AddMenu'
import {KnownHostsPage} from './lib/panels/KnownHostsPage'
import {LogsPage} from './lib/panels/LogsPage'
import {SnippetsPage} from './lib/snippets/SnippetsPage'
import {SnippetForm} from './lib/snippets/SnippetForm'
import {toTerminalInput, writeToPane} from './lib/terminal/panes'
import {PortForwardsPage} from './lib/panels/PortForwardsPage'
import {DataPanel} from './lib/panels/DataPanel'
import {SettingsWindow} from './lib/settings/SettingsWindow'
import {useAppearance} from './lib/settings/appearance'
import {SidebarTab, TerminalSidebar} from './lib/terminal/Sidebar'
import {DEFAULT_SETTINGS} from './lib/settings/defaults'
import {Nav, Page} from './lib/shell/Nav'
import {TopBar} from './lib/shell/TopBar'
import {IconPlus, IconSerial, IconTerminal} from './lib/ui/Icons'
import {recordRecent} from './lib/hosts/recent'
import {closePane, connectBlankTab, duplicateOf, hasPane, isTerminalTab, newBlankTab, leaves, MAX_TAB_TITLE, newTab, pinnedSftpTab, SFTP_TAB_ID, splitPane, Tab, toggleBroadcast, toggleZoom, uniqueTitle} from './lib/layout'
import {capture, effective, matches} from './lib/shortcuts/shortcuts'
import {errMsg} from './lib/util'
import {useToast} from './lib/ui/Toast'
import {useConfirm} from './lib/ui/Confirm'
import {DragBar} from './lib/ui/DragBar'
import type {Leaf} from './lib/layout'
import type {ForwardType, Group, PortForward, Host, Identity, Settings, Snippet, VaultStatus} from './lib/types'

type Dialog =
  | {k: 'host'; host?: Host; prefill?: QuickConnect}
  | {k: 'group'; group?: Group}
  | {k: 'forward'; forward?: PortForward; hostId?: string}
  | {k: 'snippet'; snippet?: Snippet}
  | {k: 'key'; mode: KeyMode}
  | {k: 'serial'}
  | {k: 'data'}
  | null


/** The tab to show when the active one closes: the last terminal that is left (the pinned SFTP tab does not count), else Vaults. */
const fallbackTab = (rest: Tab[]) => rest.filter(t => !t.pinned).at(-1)?.id ?? 'home'

export default function App() {
  const be = useBackend()
  const toast = useToast()
  const confirm = useConfirm()
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const saving = useRef<Promise<unknown>>(Promise.resolve())
  const [groups, setGroups] = useState<Group[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [identities, setIdentities] = useState<Identity[]>([])
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [lastTerm, setLastTerm] = useState('') // most recently focused terminal tab
  // the SFTP tab is always there, right after Vaults
  const [tabs, setTabs] = useState<Tab[]>(() => [pinnedSftpTab()])
  const [active, setActive] = useState('home') // 'home' or a tab id
  const [page, setPage] = useState<Page>('hosts')
  const [settingsOpen, setSettingsOpen] = useState(false)
  // the panel on the right of a terminal (hosts, snippets, history, themes): open or closed is remembered
  const [sidebarOpen, setSidebarOpen] = useState(() => { try { return localStorage.getItem('vvterm.sidebar') !== 'closed' } catch { return true } })
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('snippets')
  const toggleSidebar = () => setSidebarOpen(o => { try { localStorage.setItem('vvterm.sidebar', o ? 'closed' : 'open') } catch { /* not remembered */ } return !o })
  const [dialog, setDialog] = useState<Dialog>(null)
  const [draft, setDraft] = useState('')
  const [fwDraft, setFwDraft] = useState<{label: string; type: ForwardType}>({label: '', type: 'local'})
  const [fwTick, setFwTick] = useState(0) // bumped when the forwarding panel saved something
  const appearance = useAppearance(settings.theme)

  const refreshVault = useCallback(async () => setVault(await be.vault.status()), [be])
  const refreshData = useCallback(async () => {
    const [g, h, i, sn] = await Promise.all([be.hosts.listGroups(), be.hosts.listHosts({}), be.vault.listIdentities(), be.snippets.list()])
    setGroups(g ?? [])
    setHosts(h ?? [])
    setIdentities(i ?? [])
    setSnippets(sn ?? [])
  }, [be])

  const refreshDataRef = useRef<() => Promise<void> | void>(() => {})
  refreshDataRef.current = () => { if (vault?.unlocked) return refreshData() }
  useEffect(() => {
    void refreshVault()
    void be.settings.get().then(setSettings).catch(() => {})
    // the vault auto-locked (idle): drop back to the unlock screen
    const offLocked = be.on('vault:locked', () => { void refreshVault() })
    // the Settings window (its own process) changed something here: pick it up
    const offBridge = be.on('bridge:changed', (service: string) => {
      if (service === 'SettingsService') void be.settings.get().then(setSettings).catch(() => {})
      else void refreshVault().then(() => refreshDataRef.current())
    })
    // the first connection to a host revealed its server type (ubuntu, debian…): the icon changes
    const offHosts = be.on('hosts:changed', () => { void refreshDataRef.current() })
    const offMenu = be.on('menu:action', (action: string) => menuHandler.current(action))
    return () => { offLocked(); offBridge(); offHosts(); offMenu() }
  }, [be, refreshVault])

  useEffect(() => { document.documentElement.dataset.theme = appearance }, [appearance])

  // Configurable shortcuts (Settings → Shortcuts). The handlers are re-assigned on every render once the
  // vault is unlocked, so the listener below never sees stale state.
  const act = useRef<Record<string, () => void>>({})
  // what the application menu bar asks for (see app/menu.go); replaced on every render so it never sees stale state
  const menuHandler = useRef<(action: string) => void>(() => {})
  const bindings = effective(settings.shortcuts)
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (capture.active) return // the editor is recording a new shortcut
      for (const [id, combo] of Object.entries(bindingsRef.current)) {
        if (id === 'terminal_search' || id === 'terminal_copy' || id === 'terminal_paste') continue // handled by the focused terminal
        if (matches(e, combo)) {
          const fn = act.current[id]
          if (fn) { e.preventDefault(); fn() }
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // interface zoom and reduced motion
  useEffect(() => { document.documentElement.style.setProperty('zoom', String((settings.zoom || 100) / 100)) }, [settings.zoom])
  useEffect(() => { document.documentElement.dataset.motion = settings.reduce_motion ? 'reduced' : 'full' }, [settings.reduce_motion])

  // a side panel belongs to the page it was opened on: leaving the home view closes it
  const leftHome = active !== 'home' && tabs.some(t => t.id === active)
  useEffect(() => { if (leftHome) setDialog(null) }, [leftHome])
  useEffect(() => { if (vault?.unlocked) void refreshData() }, [vault?.unlocked, refreshData])

  act.current = {}
  menuHandler.current = () => {} // locked or loading: the menu does nothing
  if (!vault) return <div className="gate"><DragBar /><div className="muted">Loading…</div></div>
  if (!vault.unlocked) {
    return <UnlockScreen status={vault} onDone={() => { void refreshVault() }} />
  }

  // a second tab on the same host is numbered ("web", "web (2)"…); double-click a tab to give it any name
  const connect = (h: Host) => {
    recordRecent(h.id)
    const t = newTab(h.id, '')
    // a host that also has Telnet first asks which protocol to use
    setTabs(ts => [...ts, {...t, title: uniqueTitle(ts, h.label), choose: !!h.telnet_enabled}])
    setActive(t.id)
  }
  // a host card dropped on a group card
  const moveHost = (h: Host, groupId: string) => {
    be.hosts.saveHost({...h, group_id: groupId})
      .then(() => { void refreshData(); toast.info(groupId ? 'Moved ' + h.label + ' to ' + (groups.find(g => g.id === groupId)?.name ?? 'the group') : 'Moved ' + h.label + ' out of its group') })
      .catch(e => toast.error(errMsg(e)))
  }
  // the answer of a tab that asked which protocol to use: the same tab goes on with it
  const chooseProtocol = (tabId: string, proto: 'ssh' | 'telnet') => setTabs(ts => ts.map(t => {
    if (t.id !== tabId || t.root.type !== 'leaf') return t
    const h = hosts.find(x => x.id === (t.root as Leaf).hostId)
    const title = proto === 'telnet' && h ? uniqueTitle(ts.filter(x => x.id !== tabId), h.label + ' (Telnet)') : t.title
    return {...t, choose: false, title, root: proto === 'telnet' ? {...t.root, hostId: 'telnet:' + t.root.hostId} : t.root}
  }))
  // the + tab: a blank tab with a search box and the recent connections
  const openBlankTab = () => {
    const t = newBlankTab('')
    setTabs(ts => [...ts, {...t, title: uniqueTitle(ts, 'New Tab')}])
    setActive(t.id)
  }
  const openFromBlank = (tabId: string, h: Host) => {
    recordRecent(h.id)
    setTabs(ts => ts.map(t => (t.id === tabId ? {...connectBlankTab(t, h.id, uniqueTitle(ts.filter(x => x.id !== tabId), h.label), !!h.telnet_enabled)} : t)))
  }
  const renameTab = (id: string, name: string) => {
    const title = name.trim().slice(0, MAX_TAB_TITLE)
    if (title) setTabs(ts => ts.map(t => (t.id === id && !t.pinned ? {...t, title} : t)))
  }
  // a terminal that is not an SSH host: this computer ("local") or a serial port ("serial:<device>@<baud>")
  const openDevice = (hostId: string, title: string) => {
    const t = newTab(hostId, '')
    setTabs(ts => [...ts, {...t, title: uniqueTitle(ts, title)}])
    setActive(t.id)
  }
  const closeTab = async (id: string) => {
    const closing = tabs.find(t => t.id === id)
    if (closing?.pinned) return // the SFTP tab stays
    if (settings.confirm_tab_close && closing && !(await confirm(`Close "${closing.title}"? Its connection will end.`, {confirmLabel: 'Close tab', danger: true}))) return
    setTabs(ts => ts.filter(t => t.id !== id))
    if (id === active) {
      const rest = tabs.filter(t => t.id !== id)
      setActive(fallbackTab(rest))
    }
  }
  const split = (dir: 'row' | 'col') => setTabs(ts => ts.map(t => (t.id === active ? splitPane(t, t.activePane, dir) : t)))
  // the right-click menu of a tab acts on that tab, whichever one is showing
  const splitTab = (id: string, dir: 'row' | 'col') => { setTabs(ts => ts.map(t => (t.id === id ? splitPane(t, t.activePane, dir) : t))); setActive(id) }
  const duplicateTab = (id: string) => {
    const src = tabs.find(t => t.id === id)
    const copy = src && duplicateOf(src, uniqueTitle(tabs, src.title))
    if (!src || !copy) return
    setTabs(ts => { const i = ts.findIndex(t => t.id === id); return [...ts.slice(0, i + 1), copy, ...ts.slice(i + 1)] })
    setActive(copy.id)
  }
  // a new native window with a new session to where the tab's focused pane is connected
  const duplicateWindow = (id: string) => {
    const src = tabs.find(t => t.id === id)
    const leaf = src && leaves(src.root).find(l => l.id === src.activePane)
    if (!src || !leaf) return
    be.system.openWindow(leaf.hostId, src.title).catch(() => toast.error('New windows are not available here.'))
  }
  const broadcastTab = (id: string) => setTabs(ts => ts.map(t => (t.id === id ? toggleBroadcast(t) : t)))
  const zoomPane = (id: string, pane: string) => setTabs(ts => ts.map(t => (t.id === id ? toggleZoom(t, pane) : t)))
  const focusPane = (tabId: string, paneId: string) => setTabs(ts => ts.map(t => (t.id === tabId && hasPane(t, paneId) ? {...t, activePane: paneId} : t)))
  // the × on a pane of a split tab: ask first like closing a tab, then end just that pane's session
  const closePaneAsk = async (tabId: string, paneId: string) => {
    if (settings.confirm_tab_close && !(await confirm('Close this pane? Its connection will end.', {confirmLabel: 'Close pane', danger: true}))) return
    paneExit(tabId, paneId)
  }
  const paneExit = (tabId: string, paneId: string) => {
    const remaining = tabs.flatMap(t => {
      if (t.id !== tabId) return [t]
      const n = closePane(t, paneId)
      return n ? [n] : []
    })
    setTabs(remaining)
    if (!remaining.some(t => t.id === tabId) && active === tabId) setActive(fallbackTab(remaining))
  }
  /** types text into the focused pane (the sidebar's snippets and history); `run` presses Enter too */
  const insertIntoTerminal = (text: string, run: boolean) => {
    const tab = tabs.find(t => t.id === (tabs.some(x => x.id === active) ? active : lastTerm))
    if (!tab || !isTerminalTab(tab)) return toast.error('Open a terminal first.')
    if (!writeToPane(tab.activePane, toTerminalInput(text, run))) toast.error('The focused terminal is not connected yet.')
  }
  const runSnippet = (s: Snippet, execute: boolean) => {
    const tab = tabs.find(t => t.id === (tabs.some(x => x.id === active) ? active : lastTerm))
    if (!tab) return toast.error('Open a terminal first: the snippet is typed into the focused pane.')
    if (!writeToPane(tab.activePane, toTerminalInput(s.script, execute))) {
      return toast.error('The focused terminal is not connected yet.')
    }
    setActive(tab.id)
    toast.info(execute ? `Ran “${s.label}”` : `Pasted “${s.label}”`)
  }
  const delSnippet = async (s: Snippet) => {
    if (!(await confirm(`Delete snippet "${s.label}"?`, {confirmLabel: 'Delete', danger: true}))) return
    try { await be.snippets.remove(s.id); await refreshData() } catch (e) { toast.error(errMsg(e)) }
  }
  /** Changing page discards an open panel (New host, New group, New snippet, forwards…). */
  const changePage = (p: Page) => {
    if (p !== page) { setPage(p); setDialog(null) }
  }
  const goHome = (p?: Page) => { setActive('home'); if (p) changePage(p) }

  const delHost = async (h: Host) => {
    if (!(await confirm(`Delete host "${h.label}"?`, {confirmLabel: 'Delete', danger: true}))) return
    try { await be.hosts.deleteHost(h.id); await refreshData() } catch (e) { toast.error(errMsg(e)) }
  }
  const delGroup = async (g: Group) => {
    if (!(await confirm(`Delete group "${g.name}"? Its hosts move to the parent group.`, {confirmLabel: 'Delete', danger: true}))) return
    try { await be.hosts.deleteGroup(g.id); await refreshData() } catch (e) { toast.error(errMsg(e)) }
  }

  const close = () => setDialog(null)
  const termActive = tabs.some(t => t.id === active) ? active : ''
  const onHome = active === 'home' || !termActive
  const activeTabObj = tabs.find(t => t.id === termActive)
  if (termActive && activeTabObj && isTerminalTab(activeTabObj) && lastTerm !== termActive) setLastTerm(termActive)

  const saveSettings = (patch: Partial<Settings>) => {
    // optimistic and serialised, so quick repeats (holding a zoom shortcut) build on each other
    const next = {...settings, ...patch}
    setSettings(next)
    saving.current = saving.current
      .then(() => be.settings.save(next))
      .then(setSettings)
      .catch(e => { toast.error(errMsg(e)); setSettings(settings) })
  }
  // Settings opens as its own native window; where there is none (browser mode) the in-app window is used
  const openSettings = (toggle = false) => { void be.system.openSettings().catch(() => setSettingsOpen(o => (toggle ? !o : true))) }
  const zoomBy = (delta: number) => saveSettings({zoom: Math.max(80, Math.min(160, settings.zoom + delta))})
  const cycle = (dir: 1 | -1) => {
    const ids = ['home', ...tabs.map(t => t.id)]
    const at = onHome ? 0 : Math.max(0, ids.indexOf(termActive))
    setActive(ids[(at + dir + ids.length) % ids.length])
  }
  const inTerminalTab = !!activeTabObj && isTerminalTab(activeTabObj)
  act.current = {
    open_settings: () => openSettings(true),
    new_connection: openBlankTab,
    new_host: () => { goHome('hosts'); setDialog({k: 'host'}) },
    new_local_terminal: () => openDevice('local', 'Local'),
    lock_vault: () => { void be.vault.lock().then(refreshVault) },
    close_tab: () => { if (termActive) closeTab(termActive) },
    next_tab: () => cycle(1),
    prev_tab: () => cycle(-1),
    close_pane: () => { if (activeTabObj && inTerminalTab && !onHome) void closePaneAsk(activeTabObj.id, activeTabObj.activePane) },
    broadcast_input: () => { if (activeTabObj && inTerminalTab && !onHome) broadcastTab(activeTabObj.id) },
    split_right: () => { if (inTerminalTab) split('row') },
    split_down: () => { if (inTerminalTab) split('col') },
    zoom_in: () => zoomBy(10),
    zoom_out: () => zoomBy(-10),
    zoom_reset: () => saveSettings({zoom: 100}),
  }

  menuHandler.current = (action: string) => {
    if (action === 'new_host') { goHome('hosts'); setDialog({k: 'host'}) }
    else if (action === 'new_group') { goHome('hosts'); setDialog({k: 'group'}) }
    else if (action === 'new_terminal') openDevice('local', 'Local')
    else if (action === 'serial') { goHome('hosts'); setDialog({k: 'serial'}) }
    else if (action === 'import') setDialog({k: 'data'})
    else if (action === 'open_settings') openSettings()
    else if (action === 'duplicate_tab') { if (activeTabObj && !onHome) duplicateTab(activeTabObj.id) }
    else if (action === 'page:sftp') setActive(SFTP_TAB_ID)
    else if (action.startsWith('page:')) goHome(action.slice('page:'.length) as Page)
    else act.current[action]?.()
  }

  return (
    <div className="shell">
      <TopBar tabs={tabs} active={onHome ? 'home' : termActive} onHome={() => goHome()} onSelect={setActive} onClose={closeTab}
        onNew={openBlankTab}
        onSplit={split} onSettings={() => openSettings()} onToggleMaximise={() => void be.system.toggleMaximise()} onRename={renameTab} onDuplicate={duplicateTab} onDuplicateWindow={duplicateWindow} onSplitTab={splitTab} snippets={snippets} onRunSnippet={runSnippet}
        sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
      <div className="body">
        <div className="home" style={{display: onHome ? 'flex' : 'none'}}>
          <Nav page={page} onPage={changePage} onData={() => setDialog({k: 'data'})} settingsOpen={settingsOpen} onSettings={() => openSettings()} onLock={() => { void be.vault.lock().then(refreshVault) }} />
          <main className="main">
            {page === 'hosts' && (
              <HostList groups={groups} hosts={hosts} onMoveHost={moveHost} draft={dialog?.k === 'host' && !dialog.host?.id ? draft : undefined}
                toolbar={<>
                  <span className="split-wrap">
                    <button className="split-btn" aria-label="New host" onClick={() => setDialog({k: 'host'})}><IconPlus size={14} /> New host</button>
                    <AddMenu onGroup={() => setDialog({k: 'group'})} onImport={() => setDialog({k: 'data'})} />
                  </span>
                  <button className="ghost-btn" aria-label="Terminal" title="A terminal on this computer" onClick={() => openDevice('local', 'Local')}><IconTerminal size={14} /> Terminal</button>
                  <button className="ghost-btn" aria-label="Serial" title="Connect to a serial port" onClick={() => setDialog({k: 'serial'})}><IconSerial size={14} /> Serial</button>
                </>}
                onConnect={connect} onEdit={h => setDialog({k: 'host', host: h})} onDelete={delHost}
                onForwards={h => { goHome('forwards'); setFwDraft({label: '', type: 'local'}); setDialog({k: 'forward', hostId: h.id}) }} onTelnet={h => openDevice(`telnet:${h.id}`, `${h.label} (Telnet)`)} onEditGroup={g => setDialog({k: 'group', group: g})}
                onDeleteGroup={delGroup} onQuickConnect={q => setDialog({k: 'host', prefill: q})} />
            )}
            {page === 'keychain' && (
              <KeychainPage identities={identities} draft={dialog?.k === 'key' ? draft : undefined}
                onNew={mode => { setDraft(''); setDialog({k: 'key', mode}) }} onChanged={() => void refreshData()} />
            )}
            {page === 'snippets' && (
              <SnippetsPage snippets={snippets} canRun={tabs.some(isTerminalTab)} onNew={() => setDialog({k: 'snippet'})}
                onRun={runSnippet} onEdit={s => setDialog({k: 'snippet', snippet: s})} onDelete={delSnippet} />
            )}
            {page === 'knownhosts' && <KnownHostsPage />}
            {page === 'logs' && <LogsPage />}
            {page === 'forwards' && (
              <PortForwardsPage hosts={hosts} draft={dialog?.k === 'forward' && !dialog.forward ? fwDraft : undefined} reloadKey={fwTick}
                onNew={() => { setFwDraft({label: '', type: 'local'}); setDialog({k: 'forward'}) }} onEdit={f => setDialog({k: 'forward', forward: f})} />
            )}
          </main>
          {dialog?.k === 'host' && (
            <HostForm key={dialog.host?.id ?? dialog.prefill?.hostname ?? 'new'}
              host={dialog.host ?? (dialog.prefill ? ({id: '', label: '', hostname: dialog.prefill.hostname, port: dialog.prefill.port, username: dialog.prefill.username, keepalive_sec: 30} as Host) : undefined)}
              isNew={!dialog.host}
              groups={groups} hosts={hosts} identities={identities} onClose={close}
              onSaved={() => { close(); void refreshData() }}
              onConnect={h => { connect(h) }} onDraft={setDraft} />
          )}
          {dialog?.k === 'group' && <GroupForm group={dialog.group} groups={groups} onClose={close} onSaved={() => { close(); void refreshData() }} />}
          {dialog?.k === 'forward' && (
            <ForwardPanel key={dialog.forward?.id ?? 'new-' + (dialog.hostId ?? '')} hosts={hosts} groups={groups} forward={dialog.forward} hostId={dialog.hostId}
              onClose={close} onChanged={() => setFwTick(n => n + 1)} onDraft={setFwDraft} />
          )}
          {dialog?.k === 'serial' && <SerialPanel onClose={close} onConnect={(path, baud) => { close(); openDevice(`serial:${path}@${baud}`, portName(path)) }} />}
          {dialog?.k === 'key' && <KeyPanel key={dialog.mode} mode={dialog.mode} onClose={close} onChanged={() => void refreshData()} onDraft={setDraft} />}
          {dialog?.k === 'snippet' && <SnippetForm key={dialog.snippet?.id ?? 'new'} snippet={dialog.snippet} onClose={close} onSaved={() => { close(); void refreshData() }} />}
        </div>
        <Workspace tabs={tabs} activeTab={onHome ? '' : termActive} settings={settings} appearance={appearance} shortcuts={bindings} hosts={hosts} onFocusPane={focusPane} onPaneExit={paneExit} onClosePane={closePaneAsk} onToggleBroadcast={broadcastTab} onToggleZoom={zoomPane} onProtocol={chooseProtocol} onOpenFromNewTab={openFromBlank} onSelectTab={id => setActive(id)} groups={groups} onCloseTab={closeTab} onShowLogs={() => goHome('logs')} />
        {sidebarOpen && !onHome && activeTabObj && isTerminalTab(activeTabObj) && (
          <TerminalSidebar tab={sidebarTab} onTab={setSidebarTab} hosts={hosts} snippets={snippets} settings={settings} appearance={appearance}
            onInsert={insertIntoTerminal} onNewSnippet={() => { goHome('snippets'); setDialog({k: 'snippet'}) }} onConnect={connect} onSettings={saveSettings} />
        )}
      </div>

      {settingsOpen && (
        <SettingsWindow settings={settings} appearance={appearance} vault={vault} onSettings={setSettings}
          onVault={() => void refreshVault()} onChanged={() => void refreshData()} onClose={() => setSettingsOpen(false)} />
      )}
      {dialog?.k === 'data' && <DataPanel onClose={close} onChanged={() => void refreshData()} />}
    </div>
  )
}
