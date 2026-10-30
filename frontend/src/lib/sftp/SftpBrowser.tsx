import {useCallback, useEffect, useRef, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {errMsg} from '../util'
import {IconClose, IconDownload, IconFolder, IconPlus} from '../ui/Icons'
import {OsIcon} from '../ui/OsIcon'
import {DragPayload, FilePane, Item, PaneFs, PaneState} from './FilePane'
import {RemoteHost, RemotePane} from './RemotePane'
import {QueuePanel} from './QueuePanel'
import {SyncDialog} from './SyncDialog'
import {queueTransfer, replaceQuestion, summarize, useQueues, verbOf} from './transfer'
import type {Host, QueueJob} from '../types'

export {replaceQuestion, summarize}

const NONE: PaneState = {cwd: '', selected: []}
interface RemoteTab {key: string; host: RemoteHost}
let tabSeq = 0
const nextTabKey = () => 'rt' + tabSeq++
/**
 * The SFTP screen, like Termius: this computer on the left, a saved host on the right. Select one or more
 * files and folders (Cmd/Ctrl-click, Shift-click), then drag them across or use Upload (in the Actions menu) / Download
 * buttons. Folders go with everything inside. Nothing is replaced without asking, and the question comes
 * once for the whole batch. Transfers run in a queue in the background: they can be paused, resumed, cancelled and
 * retried, and a broken one continues where it stopped.
 */
/** sent by the app when the Close tab shortcut is used on an SFTP screen: close the host tab that is showing */
export const CLOSE_HOST_TAB = 'vvterm:sftp-close-host'

export function SftpBrowser({hostId = '', hostLabel = '', nonce = 0, hosts: given, visible = true}: {hostId?: string; hostLabel?: string; nonce?: number; /** this screen is the one showing (only that one answers the Close tab shortcut) */ visible?: boolean; /** the app's current hosts (kept up to date by the app); without it they are loaded once */ hosts?: Host[]}) {
  const be = useBackend()
  const toast = useToast()
  const confirm = useConfirm()
  // the hosts open on the right, as tabs in the pane header; every one keeps its own connection, folder and selection
  const [tabs, setTabs] = useState<RemoteTab[]>(() => (hostId ? [{key: nextTabKey(), host: {id: hostId, label: hostLabel || hostId}}] : []))
  const [activeKey, setActiveKey] = useState(() => tabs[0]?.key ?? '')
  const active = tabs.find(t => t.key === activeKey) ?? null
  const host = active?.host ?? null
  const [loaded, setLoaded] = useState<Host[]>([])
  const hosts = given ?? loaded
  const [localHome, setLocalHome] = useState('')
  const [local, setLocal] = useState<PaneState>(NONE)
  const [remotes, setRemotes] = useState<Record<string, PaneState>>({})
  const [sids, setSids] = useState<Record<string, string>>({})
  const remote = remotes[activeKey] ?? NONE
  const sid = sids[activeKey] ?? ''
  const [localKey, setLocalKey] = useState(0)
  const [remoteKey, setRemoteKey] = useState(0)
  const [error, setError] = useState('')
  const [queueOpen, setQueueOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // the callbacks of a pane must keep one identity (the pane reports into them from effects), so one pair per tab
  const callbacks = useRef(new Map<string, {onState(s: PaneState): void; onSession(id: string): void}>())
  const cbFor = (key: string) => {
    let c = callbacks.current.get(key)
    if (!c) {
      c = {onState: st => setRemotes(m => ({...m, [key]: st})), onSession: id => setSids(m => (m[key] === id ? m : {...m, [key]: id}))}
      callbacks.current.set(key, c)
    }
    return c
  }
  const addTab = (h: RemoteHost) => {
    const key = nextTabKey()
    setTabs(ts => [...ts, {key, host: h}])
    setActiveKey(key)
  }
  const closeTab = (key: string) => {
    const at = tabs.findIndex(t => t.key === key)
    const rest = tabs.filter(t => t.key !== key)
    setTabs(rest)
    if (key === activeKey) setActiveKey(rest[Math.max(0, at - 1)]?.key ?? '')
    callbacks.current.delete(key)
    setRemotes(m => { const n = {...m}; delete n[key]; return n })
    setSids(m => { const n = {...m}; delete n[key]; return n })
  }

  const activeRef = useRef(activeKey)
  activeRef.current = activeKey
  useEffect(() => {
    if (!visible) return
    const close = () => { if (activeRef.current) closeTab(activeRef.current) }
    window.addEventListener(CLOSE_HOST_TAB, close)
    return () => window.removeEventListener(CLOSE_HOST_TAB, close)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tabs])

  // a host card asked for this host (again): connect to it in a tab of its own (not on the first run: the tab is already there)
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    if (hostId) addTab({id: hostId, label: hostLabel || hostId})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, nonce])
  useEffect(() => {
    void be.local.home().then(setLocalHome).catch(e => setError(errMsg(e)))
    if (!given) void be.hosts.listHosts({}).then(h => setLoaded(h ?? [])).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [be])
  // a finished job refreshes the side it wrote to and says what it did
  const finished = useCallback((_sid: string, j: QueueJob) => {
    const toRemote = j.direction === 'upload' || j.direction === 'sync-up'
    if (j.state === 'done') toast.info(summarize(verbOf(j.direction), j))
    else if (j.state === 'failed') toast.error(`${j.name}: ${j.error || 'the transfer failed'}`)
    if (j.state === 'canceled' || j.state === 'done' || j.state === 'failed') { if (toRemote) setRemoteKey(k => k + 1); else setLocalKey(k => k + 1) }
  }, [toast])
  const queues = useQueues(Object.values(sids), finished)
  const jobs = queues[sid] ?? []
  const queueActions = {
    pause: (id: string) => void be.sftp.pause(sid, id).catch(e => setError(errMsg(e))),
    resume: (id: string) => void be.sftp.resume(sid, id).catch(e => setError(errMsg(e))),
    cancel: (id: string) => void be.sftp.cancel(sid, id).catch(e => setError(errMsg(e))),
    retry: (id: string) => void be.sftp.retry(sid, id).catch(e => setError(errMsg(e))),
    clearFinished: () => void be.sftp.clearFinished(sid).then(() => be.sftp.queue(sid)).catch(e => setError(errMsg(e))),
  }

  // keep one identity across renders so the pane does not reload every time
  const [fs] = useState<PaneFs>(() => ({
    list: d => be.local.list(d),
    mkdir: p => be.local.mkdir(p),
    rename: (a, b) => be.local.rename(a, b),
    remove: (p, isDir) => be.local.remove(p, isDir),
    chmod: (p, m) => be.local.chmod(p, m),
    open: e => be.system.openPath(e.path),
    openWith: async e => {
      const app = await be.system.pickFile('Open with…')
      if (app) await be.system.openPathWith(e.path, app)
    },
  }))

  /** Queues everything given; files that already exist are asked about once. */
  const move = async (direction: 'upload' | 'download', items: Item[]) => {
    if (!sid) return setError('Connect to a host first')
    const toRemote = direction === 'upload'
    const destDir = toRemote ? remote.cwd : local.cwd
    if (!destDir) return setError('Open a folder on the receiving side first')
    if (items.length === 0) return
    setError('')
    try {
      await queueTransfer(be, confirm, sid, direction, items.map(i => i.path), destDir)
      setQueueOpen(true)
    } catch (err) {
      setError(errMsg(err))
    }
  }

  const onDropToRemote = useCallback((p: DragPayload) => { void move('upload', p.items) }, [sid, remote.cwd]) // eslint-disable-line react-hooks/exhaustive-deps
  const onDropToLocal = useCallback((p: DragPayload) => { void move('download', p.items) }, [sid, local.cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  const canDown = !!sid && remote.selected.length > 0
  const count = (n: number) => (n > 1 ? ` ${n}` : '')

  return (
    <div className="sftp" data-testid="sftp" aria-label={host ? `SFTP ${host.label}` : 'SFTP'}>
      <div className="sftp-panes">
        <FilePane side="local" title="Local" icon={<IconFolder size={16} />} fs={localHome ? fs : null} startDir={localHome} reloadKey={localKey} showHiddenDefault={false}
          onState={setLocal} onDropEntry={onDropToLocal} onCopyOut={sid ? items => void move('upload', items) : undefined} copyLabel="Upload" />
        <div className="rpanes">
          {tabs.map(t => {
            const cb = cbFor(t.key)
            return (
              <RemotePane key={t.key} host={t.host} hosts={hosts} hidden={t.key !== activeKey} onNewTab={addTab} onHost={() => closeTab(t.key)} reloadKey={remoteKey}
                onState={cb.onState} onDropEntry={onDropToRemote} onSession={cb.onSession} onCopyOut={items => void move('download', items)}
                tabsLead={add => (
                  <div className="rtabs" role="tablist" aria-label="Remote hosts">
                    {tabs.map(x => (
                      <div key={x.key} role="tab" aria-selected={x.key === activeKey} className={'rtab' + (x.key === activeKey ? ' on' : '')} onClick={() => setActiveKey(x.key)}>
                        <OsIcon os={hosts.find(h => h.id === x.host.id)?.os} size={15} />
                        <span className="rtab-name">{x.host.label}</span>
                        <button className="icon ghost fpane-x" aria-label={tabs.length === 1 ? 'Change host' : `Close ${x.host.label}`} title={tabs.length === 1 ? 'Disconnect and pick another host' : 'Close this host'}
                          onClick={e => { e.stopPropagation(); closeTab(x.key) }}><IconClose size={13} /></button>
                      </div>
                    ))}
                    <button className="icon ghost fpane-x" aria-label="Add host" title="Connect to another host" onClick={add}><IconPlus size={14} /></button>
                  </div>
                )} />
            )
          })}
          {tabs.length === 0 && (
            <RemotePane host={null} hosts={hosts} onHost={h => { if (h) addTab(h) }} reloadKey={remoteKey}
              onState={cbFor('none').onState} onDropEntry={onDropToRemote} onSession={cbFor('none').onSession} />
          )}
        </div>
      </div>
      <div className="sftp-foot">
        <button disabled={!canDown} onClick={() => void move('download', remote.selected)} aria-label="Download selected"><IconDownload size={15} /> Download{count(remote.selected.length)} to local folder</button>
        <button disabled={!sid || !local.cwd || !remote.cwd} onClick={() => setSyncing(true)} aria-label="Sync folders">Sync folders…</button>
        {error && <div className="error" role="alert">{error}</div>}
      </div>
      <QueuePanel jobs={jobs} actions={queueActions} open={queueOpen} onToggle={() => setQueueOpen(o => !o)} />
      {syncing && <SyncDialog sid={sid} localDir={local.cwd} remoteDir={remote.cwd} onClose={() => setSyncing(false)} onQueued={() => setQueueOpen(true)} />}
    </div>
  )
}
