import {useCallback, useEffect, useState} from 'react'
import {useBackend} from './lib/backend'
import {UnlockScreen} from './lib/vault/UnlockScreen'
import {IdentitiesPanel} from './lib/vault/IdentitiesPanel'
import {HostList} from './lib/hosts/HostList'
import {GroupForm, HostForm} from './lib/hosts/HostForm'
import {Workspace} from './lib/terminal/Workspace'
import {ForwardsPanel} from './lib/panels/ForwardsPanel'
import {DataPanel} from './lib/panels/DataPanel'
import {SyncPanel} from './lib/panels/SyncPanel'
import {SettingsPanel} from './lib/panels/SettingsPanel'
import {closePane, hasPane, newTab, splitPane, Tab} from './lib/layout'
import {errMsg} from './lib/util'
import {useToast} from './lib/ui/Toast'
import type {Group, Host, Identity, Settings, VaultStatus} from './lib/types'

type Dialog =
  | {k: 'host'; host?: Host}
  | {k: 'group'; group?: Group}
  | {k: 'identities'}
  | {k: 'forwards'; host: Host}
  | {k: 'data'}
  | {k: 'sync'}
  | {k: 'settings'}
  | null

const DEFAULT_SETTINGS: Settings = {theme: 'dark', font_size: 13, font_family: 'Menlo, monospace', auto_lock_minutes: 15, sync_url: ''}

export default function App() {
  const be = useBackend()
  const toast = useToast()
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [groups, setGroups] = useState<Group[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [identities, setIdentities] = useState<Identity[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)

  const refreshVault = useCallback(async () => setVault(await be.vault.status()), [be])
  const refreshData = useCallback(async () => {
    const [g, h, i] = await Promise.all([be.hosts.listGroups(), be.hosts.listHosts({}), be.vault.listIdentities()])
    setGroups(g ?? [])
    setHosts(h ?? [])
    setIdentities(i ?? [])
  }, [be])

  useEffect(() => {
    void refreshVault()
    void be.settings.get().then(setSettings).catch(() => {})
    // the vault auto-locked (idle or sleep): drop back to the unlock screen and close terminals
    return be.on('vault:locked', () => { void refreshVault() })
  }, [be, refreshVault])

  useEffect(() => { document.documentElement.dataset.theme = settings.theme }, [settings.theme])
  useEffect(() => { if (vault?.unlocked) void refreshData() }, [vault?.unlocked, refreshData])

  if (!vault) return <div className="gate"><div className="muted">Loading…</div></div>
  if (!vault.unlocked) {
    return <UnlockScreen status={vault} onDone={() => { void refreshVault() }} />
  }

  const connect = (h: Host) => {
    const t = newTab(h.id, h.label)
    setTabs(ts => [...ts, t])
    setActive(t.id)
  }
  const closeTab = (id: string) => {
    setTabs(ts => {
      const next = ts.filter(t => t.id !== id)
      if (id === active) setActive(next.length ? next[next.length - 1].id : '')
      return next
    })
  }
  const split = (dir: 'row' | 'col') => setTabs(ts => ts.map(t => (t.id === active ? splitPane(t, t.activePane, dir) : t)))
  const focusPane = (tabId: string, paneId: string) => setTabs(ts => ts.map(t => (t.id === tabId && hasPane(t, paneId) ? {...t, activePane: paneId} : t)))
  const paneExit = (tabId: string, paneId: string) => {
    setTabs(ts => ts.flatMap(t => {
      if (t.id !== tabId) return [t]
      const n = closePane(t, paneId)
      return n ? [n] : []
    }))
    setActive(a => (a === tabId && !tabs.some(t => t.id !== tabId) ? '' : a))
  }

  const delHost = async (h: Host) => {
    if (!window.confirm(`Delete host "${h.label}"?`)) return
    try { await be.hosts.deleteHost(h.id); await refreshData() } catch (e) { toast.error(errMsg(e)) }
  }
  const delGroup = async (g: Group) => {
    if (!window.confirm(`Delete group "${g.name}"? Its hosts move to the parent group.`)) return
    try { await be.hosts.deleteGroup(g.id); await refreshData() } catch (e) { toast.error(errMsg(e)) }
  }

  const close = () => setDialog(null)
  const activeTab = tabs.find(t => t.id === active) ? active : tabs[0]?.id ?? ''

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <span>⌘ VVTerm</span>
            <span>
              <button className="icon" title="New host" aria-label="New host" onClick={() => setDialog({k: 'host'})}>＋ Host</button>{' '}
              <button className="icon" title="New group" aria-label="New group" onClick={() => setDialog({k: 'group'})}>＋ Group</button>
            </span>
          </div>
        </div>
        <HostList groups={groups} hosts={hosts} onConnect={connect}
          onEdit={h => setDialog({k: 'host', host: h})} onDelete={delHost} onForwards={h => setDialog({k: 'forwards', host: h})}
          onEditGroup={g => setDialog({k: 'group', group: g})} onDeleteGroup={delGroup} />
        <div className="sidebar-foot">
          <button onClick={() => setDialog({k: 'identities'})}>🔑 Vault</button>
          <button onClick={() => setDialog({k: 'data'})}>⇅ Data</button>
          <button onClick={() => setDialog({k: 'sync'})}>☁ Sync</button>
          <button onClick={() => setDialog({k: 'settings'})}>⚙ Settings</button>
          <button onClick={() => { void be.vault.lock().then(refreshVault) }}>🔒 Lock</button>
        </div>
      </aside>
      <Workspace tabs={tabs} activeTab={activeTab} settings={settings} onSelect={setActive} onClose={closeTab}
        onSplit={split} onFocusPane={focusPane} onPaneExit={paneExit} />

      {dialog?.k === 'host' && (
        <HostForm host={dialog.host} groups={groups} hosts={hosts} identities={identities} onClose={close}
          onSaved={() => { close(); void refreshData() }} />
      )}
      {dialog?.k === 'group' && <GroupForm group={dialog.group} groups={groups} onClose={close} onSaved={() => { close(); void refreshData() }} />}
      {dialog?.k === 'identities' && <IdentitiesPanel onClose={close} onChanged={() => void refreshData()} />}
      {dialog?.k === 'forwards' && <ForwardsPanel host={dialog.host} onClose={close} />}
      {dialog?.k === 'data' && <DataPanel onClose={close} onChanged={() => void refreshData()} />}
      {dialog?.k === 'sync' && <SyncPanel vault={vault} onClose={close} onChanged={() => void refreshData()} />}
      {dialog?.k === 'settings' && (
        <SettingsPanel vault={vault} onClose={close} onSettings={setSettings} onVault={() => void refreshVault()} />
      )}
    </div>
  )
}
