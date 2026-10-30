import {ReactNode, useEffect, useMemo, useRef, useState} from 'react'
import {useBackend} from '../backend'
import {errMsg} from '../util'
import {useConfirm} from '../ui/Confirm'
import {useToast} from '../ui/Toast'
import {IconFolder} from '../ui/Icons'
import {OsIcon} from '../ui/OsIcon'
import {joinPath} from './format'
import {FilePane, PaneFs, PaneState, DragPayload, Item} from './FilePane'
import type {EditEvent, Host, HostKeyPrompt} from '../types'

export interface RemoteHost {id: string; label: string}
let seq = 0

interface Props {
  host: RemoteHost | null
  hosts: Host[]
  onHost(h: RemoteHost | null): void
  /** a host was picked while one is open: it becomes one more tab of this pane */
  onNewTab?(h: RemoteHost): void
  /** the host tabs shown in the header; `add` opens the host list */
  tabsLead?(add: () => void): ReactNode
  /** another host's tab is showing: keep this connection alive but out of sight */
  hidden?: boolean
  reloadKey: number
  onState(s: PaneState): void
  onDropEntry(p: DragPayload): void
  /** the SFTP session id once connected ('' when not) */
  onSession(sid: string): void
  /** right-click: copy what is chosen to the folder open on this computer */
  onCopyOut?(items: Item[]): void
}

/**
 * The Remote side: shows "Connect to host" until a saved host is chosen, then owns that host's SFTP
 * connection (through its jump chain, with the host key prompt) and browses it in a FilePane.
 */
export function RemotePane({host, hosts, onHost, onNewTab, tabsLead, hidden, reloadKey, onState, onDropEntry, onSession, onCopyOut}: Props) {
  const be = useBackend()
  const confirm = useConfirm()
  const toast = useToast()
  const sid = useRef('')
  const edited = useRef(new Set<string>()) // remote files being edited here: each is released when the connection ends
  const alive = useRef(true)
  const [state, setState] = useState<'connecting' | 'ready' | 'closed'>('connecting')
  const [home, setHome] = useState('')
  const [closedReason, setClosedReason] = useState('')
  const [prompt, setPrompt] = useState<{key: string; p: HostKeyPrompt} | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState('')
  const [fs, setFs] = useState<PaneFs | null>(null)

  const hostId = host?.id ?? ''
  useEffect(() => {
    setFs(null)
    setHome('')
    onSession('')
    if (!hostId) return
    alive.current = true
    const key = `sftp-${Date.now().toString(36)}-${++seq}`
    const offs: Array<() => void> = [be.on(`term:hostkey:${key}`, (p: HostKeyPrompt) => setPrompt({key, p}))]
    setState('connecting')
    setClosedReason('')
    ;(async () => {
      try {
        const info = await be.sftp.open(hostId, key)
        if (!alive.current) { void be.sftp.close(info.sid).catch(() => {}); return }
        sid.current = info.sid
        offs.push(be.on(`sftp:edit:${info.sid}`, (ev: EditEvent) => {
          const name = ev.remote.slice(ev.remote.lastIndexOf('/') + 1)
          if (ev.state === 'uploaded') toast.info(`Saved ${name} to the server`)
          else if (ev.state === 'error') toast.error(`${name}: ${ev.message || 'could not be saved to the server'}`)
          else void confirm(`${name} changed on the server since you opened it. Overwrite with your version?`, {confirmLabel: 'Overwrite', danger: true})
            .then(yes => (yes ? be.sftp.editPush(info.sid, ev.remote, true) : undefined))
            .catch(e => toast.error(`${name}: ${errMsg(e)}`))
        }))
        offs.push(be.on(`sftp:closed:${info.sid}`, () => { setState('closed'); setClosedReason('The connection was lost.'); sid.current = ''; setFs(null); onSession('') }))
        setPrompt(null)
        const s = info.sid
        setFs({
          list: d => be.sftp.list(s, d),
          mkdir: p => be.sftp.mkdir(s, p),
          rename: (a, b) => be.sftp.rename(s, a, b),
          remove: (p, isDir) => be.sftp.remove(s, p, isDir),
          chmod: (p, m) => be.sftp.chmod(s, p, m),
          // a remote file is fetched into a private temporary folder and opened from there
          open: async e => {
            const dir = await be.local.tempDir()
            const res = await be.sftp.downloadAll(s, [e.path], dir, true)
            if (res.files < 1) throw new Error('Could not download the file')
            await be.system.openPath(joinPath(dir, e.name))
          },
          openWith: async e => {
            const app = await be.system.pickFile('Open with…')
            if (!app) return
            const dir = await be.local.tempDir()
            await be.sftp.downloadAll(s, [e.path], dir, true)
            await be.system.openPathWith(joinPath(dir, e.name), app)
          },
          // fetched like Open, then the file is watched: each save goes back to the server
          edit: async e => {
            const dir = await be.local.tempDir()
            const res = await be.sftp.downloadAll(s, [e.path], dir, true)
            if (res.files < 1) throw new Error('Could not download the file')
            const local = joinPath(dir, e.name)
            await be.system.openPath(local)
            await be.sftp.editStart(s, e.path, local)
            edited.current.add(e.path)
          },
        })
        setHome(info.home || '/')
        setState('ready')
        onSession(s)
      } catch (e) {
        if (alive.current) { setPrompt(null); setState('closed'); setClosedReason(errMsg(e)) }
      }
    })()
    return () => {
      alive.current = false
      offs.forEach(o => o())
      if (sid.current) {
        for (const p of edited.current) void be.sftp.editStop(sid.current, p).catch(() => {})
        void be.sftp.close(sid.current).catch(() => {})
      }
      edited.current.clear()
      sid.current = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [be, hostId, attempt])

  const answer = (trust: boolean) => {
    if (!prompt) return
    void be.session.trustHostKey(prompt.key, trust ? prompt.p.fingerprint : '').catch(e => setClosedReason(errMsg(e)))
    setPrompt(null)
  }

  const matching = useMemo(() => hosts.filter(h => (h.label + ' ' + h.hostname).toLowerCase().includes(filter.trim().toLowerCase())), [hosts, filter])

  const picker = (
    <div className="host-picker">
      <h3>Select host</h3>
      <input aria-label="Filter hosts" autoFocus placeholder="Search hosts" value={filter} onChange={e => setFilter(e.target.value)} />
      <div className="host-picker-list">
        {matching.map(h => (
          <button key={h.id} aria-label={`Connect to ${h.label}`} onClick={() => { setPicking(false); setFilter(''); const r = {id: h.id, label: h.label}; if (host && onNewTab) onNewTab(r); else onHost(r) }}>
            <OsIcon os={h.os} size={18} /><span>{h.label}</span><small className="muted">{h.username ? h.username + '@' : ''}{h.hostname}</small>
          </button>
        ))}
        {matching.length === 0 && <div className="muted">{hosts.length ? 'No host matches.' : 'No saved hosts yet. Add one in Hosts first.'}</div>}
      </div>
      <button onClick={() => { setPicking(false); setFilter('') }}>Cancel</button>
    </div>
  )

  if (!host) {
    return (
      <section className="fpane" aria-label="Remote">
        <div className="fpane-empty">
          {!picking ? (
            <>
              <span className="fpane-empty-icon"><IconFolder size={28} /></span>
              <h3>Connect to host</h3>
              <p className="muted">Start by connecting to a saved host to manage your files with SFTP.</p>
              <button className="primary" onClick={() => setPicking(true)}>Select host</button>
            </>
          ) : picker}
        </div>
      </section>
    )
  }

  return (
    <div className="rpane" style={hidden ? {display: 'none'} : undefined}>
      <FilePane side="remote" title={host.label} icon={<OsIcon os={hosts.find(x => x.id === host.id)?.os} size={16} />} fs={fs} startDir={home} reloadKey={reloadKey} showHiddenDefault
        onState={onState} onDropEntry={onDropEntry} onCopyOut={onCopyOut} copyLabel="Download" onClose={() => onHost(null)} onAdd={() => setPicking(true)} lead={tabsLead?.(() => setPicking(true))} />
      {picking && <div className="overlay" role="dialog" aria-label="Select host"><div className="card">{picker}</div></div>}
      {state === 'connecting' && !prompt && <div className="banner info">Connecting to {host.label}…</div>}
      {state === 'closed' && (
        <div className="banner" role="alert">
          <span>{closedReason || 'Disconnected.'}</span>
          <button className="on-banner" onClick={() => setAttempt(a => a + 1)}>Reconnect</button>
        </div>
      )}
      {prompt && (
        <div className="overlay" role="alertdialog" aria-label="Host key confirmation">
          <div className="card">
            <h3 style={{marginTop: 0}}>Unknown host key</h3>
            <div>The authenticity of <b>{prompt.p.host}</b> can't be established.</div>
            <div className="muted">{prompt.p.key_type} fingerprint</div>
            <div className="fp" data-testid="fingerprint">{prompt.p.fingerprint}</div>
            <div className="row">
              <button className="primary" onClick={() => answer(true)}>Trust and connect</button>
              <button onClick={() => answer(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
