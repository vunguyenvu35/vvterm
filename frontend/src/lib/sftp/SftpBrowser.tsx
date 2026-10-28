import {useCallback, useEffect, useRef, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {errMsg} from '../util'
import {IconClose, IconDownload, IconFolder, IconPlus} from '../ui/Icons'
import {OsIcon} from '../ui/OsIcon'
import {formatBytes} from './format'
import {DragPayload, FilePane, Item, PaneFs, PaneState} from './FilePane'
import {RemoteHost, RemotePane} from './RemotePane'
import type {Host, TransferProgress, TransferResult} from '../types'

const NONE: PaneState = {cwd: '', selected: []}
interface RemoteTab {key: string; host: RemoteHost}
let tabSeq = 0
const nextTabKey = () => 'rt' + tabSeq++
/** how long the progress bar stays after a transfer finished */
export const TRANSFER_HIDE_MS = 2000

/** "Uploaded 12 files and 3 folders (1.2 MB), 2 left as they were" */
export function summarize(verb: string, r: TransferResult): string {
  const parts = [
    r.files ? `${r.files} ${r.files === 1 ? 'file' : 'files'}` : '',
    r.dirs ? `${r.dirs} ${r.dirs === 1 ? 'folder' : 'folders'}` : '',
  ].filter(Boolean)
  let text = parts.length ? `${verb} ${parts.join(' and ')} (${formatBytes(r.bytes)})` : 'Nothing to transfer'
  if (r.skipped.length) text += `, ${r.skipped.length} left as they were`
  if (r.ignored.length) text += `, ${r.ignored.length} ${r.ignored.length === 1 ? 'link' : 'links'} ignored`
  return text
}

/** The one question asked when files already exist where they are going. */
export function replaceQuestion(r: TransferResult, where: string): string {
  if (r.skipped.length === 1) return `${r.skipped[0]} already exists in ${where}. Replace it?`
  const first = r.skipped.slice(0, 3).join(', ') + (r.skipped.length > 3 ? ', …' : '')
  return `${r.skipped.length} files already exist in ${where} (${first}). Replace them?`
}

/**
 * The SFTP screen, like Termius: this computer on the left, a saved host on the right. Select one or more
 * files and folders (Cmd/Ctrl-click, Shift-click), then drag them across or use Upload (in the Actions menu) / Download
 * buttons. Folders go with everything inside. Nothing is replaced without asking, and the question comes
 * once for the whole batch.
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
  const [transfer, setTransfer] = useState<TransferProgress | null>(null)
  const [error, setError] = useState('')

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
    setTransfer(null)
  }
  const closeTab = (key: string) => {
    const at = tabs.findIndex(t => t.key === key)
    const rest = tabs.filter(t => t.key !== key)
    setTabs(rest)
    if (key === activeKey) setActiveKey(rest[Math.max(0, at - 1)]?.key ?? '')
    callbacks.current.delete(key)
    setRemotes(m => { const n = {...m}; delete n[key]; return n })
    setSids(m => { const n = {...m}; delete n[key]; return n })
    setTransfer(null)
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
  // a finished transfer shows "done" for a moment and then goes away by itself
  useEffect(() => {
    if (!transfer || transfer.total <= 0 || transfer.done < transfer.total) return
    const t = window.setTimeout(() => setTransfer(null), TRANSFER_HIDE_MS)
    return () => window.clearTimeout(t)
  }, [transfer])
  useEffect(() => (sid ? be.on(`sftp:progress:${sid}`, (t: TransferProgress) => setTransfer(t)) : undefined), [be, sid])

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

  /** Moves everything given: existing files are skipped first, and one question offers to replace them. */
  const move = async (direction: 'upload' | 'download', items: Item[]) => {
    if (!sid) return setError('Connect to a host first')
    const toRemote = direction === 'upload'
    const destDir = toRemote ? remote.cwd : local.cwd
    if (!destDir) return setError('Open a folder on the receiving side first')
    if (items.length === 0) return
    setError('')
    const paths = items.map(i => i.path)
    const go = (overwrite: boolean) => (toRemote ? be.sftp.uploadAll(sid, paths, destDir, overwrite) : be.sftp.downloadAll(sid, paths, destDir, overwrite))
    try {
      let res = await go(false)
      if (res.skipped.length && (await confirm(replaceQuestion(res, destDir), {confirmLabel: 'Replace', danger: true}))) res = await go(true)
      toast.info(summarize(toRemote ? 'Uploaded' : 'Saved', res))
    } catch (err) {
      setError(errMsg(err))
    } finally {
      if (toRemote) setRemoteKey(k => k + 1)
      else setLocalKey(k => k + 1)
    }
  }

  const onDropToRemote = useCallback((p: DragPayload) => { void move('upload', p.items) }, [sid, remote.cwd]) // eslint-disable-line react-hooks/exhaustive-deps
  const onDropToLocal = useCallback((p: DragPayload) => { void move('download', p.items) }, [sid, local.cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  const pct = transfer && transfer.total > 0 ? Math.min(100, Math.round((transfer.done / transfer.total) * 100)) : 0
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
        {transfer && (
          <div className="sftp-transfer" role="status" aria-label="Transfer progress">
            <span>{transfer.direction === 'upload' ? 'Uploading' : 'Downloading'} {transfer.name}</span>
            <div className="bar"><i style={{width: pct + '%'}} /></div>
            <span className="muted">{pct >= 100 ? 'done' : `${pct}% · ${formatBytes(transfer.done)} of ${formatBytes(transfer.total)}`}</span>
          </div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    </div>
  )
}
