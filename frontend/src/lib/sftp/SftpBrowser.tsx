import {useCallback, useEffect, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {errMsg} from '../util'
import {IconDownload, IconFolder, IconUpload} from '../ui/Icons'
import {formatBytes} from './format'
import {DragPayload, FilePane, Item, PaneFs, PaneState} from './FilePane'
import {RemoteHost, RemotePane} from './RemotePane'
import type {Host, TransferProgress, TransferResult} from '../types'

const NONE: PaneState = {cwd: '', selected: []}
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
 * files and folders (Cmd/Ctrl-click, Shift-click), then drag them across or use the Upload / Download
 * buttons. Folders go with everything inside. Nothing is replaced without asking, and the question comes
 * once for the whole batch.
 */
export function SftpBrowser({hostId = '', hostLabel = '', nonce = 0}: {hostId?: string; hostLabel?: string; nonce?: number}) {
  const be = useBackend()
  const toast = useToast()
  const confirm = useConfirm()
  const [host, setHost] = useState<RemoteHost | null>(hostId ? {id: hostId, label: hostLabel || hostId} : null)
  const [hosts, setHosts] = useState<Host[]>([])
  const [localHome, setLocalHome] = useState('')
  const [local, setLocal] = useState<PaneState>(NONE)
  const [remote, setRemote] = useState<PaneState>(NONE)
  const [sid, setSid] = useState('')
  const [localKey, setLocalKey] = useState(0)
  const [remoteKey, setRemoteKey] = useState(0)
  const [transfer, setTransfer] = useState<TransferProgress | null>(null)
  const [error, setError] = useState('')

  // a host card asked for this host (again): connect to it, even when it is the one that was just left
  useEffect(() => {
    if (hostId) { setHost({id: hostId, label: hostLabel || hostId}); setTransfer(null); setRemote(NONE) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, nonce])
  useEffect(() => {
    void be.local.home().then(setLocalHome).catch(e => setError(errMsg(e)))
    void be.hosts.listHosts({}).then(h => setHosts(h ?? [])).catch(() => {})
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
  const canUp = !!sid && local.selected.length > 0
  const canDown = !!sid && remote.selected.length > 0
  const count = (n: number) => (n > 1 ? ` ${n}` : '')

  return (
    <div className="sftp" data-testid="sftp" aria-label={host ? `SFTP ${host.label}` : 'SFTP'}>
      <div className="sftp-panes">
        <FilePane side="local" title="Local" icon={<IconFolder size={16} />} fs={localHome ? fs : null} startDir={localHome} reloadKey={localKey} showHiddenDefault={false}
          actions={<button disabled={!canUp} onClick={() => void move('upload', local.selected)} aria-label="Upload selected"><IconUpload size={15} /> Upload{count(local.selected.length)}</button>}
          onState={setLocal} onDropEntry={onDropToLocal} />
        <RemotePane host={host} hosts={hosts} onHost={h => { setHost(h); setTransfer(null); setRemote(NONE) }} reloadKey={remoteKey}
          onState={setRemote} onDropEntry={onDropToRemote} onSession={setSid} />
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
