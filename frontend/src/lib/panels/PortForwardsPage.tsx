import {useCallback, useEffect, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {errMsg} from '../util'
import {IconEdit, IconPlus, IconTrash} from '../ui/Icons'
import {TYPE_LABEL} from './ForwardPanel'
import type {ForwardStatus, ForwardType, Host, HostKeyPrompt, PortForward} from '../types'

export function describeForward(f: PortForward): string {
  const bind = `${f.bind_addr}:${f.bind_port || 'auto'}`
  if (f.type === 'dynamic') return `SOCKS5 ${bind}`
  return `${bind} → ${f.dest_host}:${f.dest_port}`
}

/** The name on a card: the label, or "Local Rule" style when there is none. */
export const forwardTitle = (f: PortForward) => f.label || `${TYPE_LABEL[f.type]} Rule`

interface Props {
  hosts: Host[]
  /** the New Port Forwarding panel is open: a highlighted draft card shows what is being typed */
  draft?: {label: string; type: ForwardType}
  /** bump to re-read the list after the panel saved something */
  reloadKey?: number
  onNew(): void
  onEdit(f: PortForward): void
}

/** Port Forwarding, like Termius: one card per rule (L / R / D), a New forwarding button, and a docked panel to add or edit. */
export function PortForwardsPage({hosts, draft, reloadKey = 0, onNew, onEdit}: Props) {
  const be = useBackend()
  const toast = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState<ForwardStatus[]>([])
  const [prompt, setPrompt] = useState<{id: string; p: HostKeyPrompt} | null>(null)

  const reload = useCallback(async () => setItems((await be.forwards.list()) ?? []), [be])
  useEffect(() => {
    void reload()
    return be.on('forward:state', () => void reload())
  }, [be, reload, reloadKey])

  const hostOf = (id: string) => hosts.find(h => h.id === id)

  const start = async (id: string) => {
    const off = be.on('term:hostkey:fwd-' + id, (p: HostKeyPrompt) => setPrompt({id, p}))
    try {
      await be.forwards.start(id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      off()
      setPrompt(null)
      void reload()
    }
  }
  const stop = (id: string) => be.forwards.stop(id).then(reload).catch(e => toast.error(errMsg(e)))
  const remove = async (s: ForwardStatus) => {
    if (!(await confirm(`Delete "${forwardTitle(s.forward)}"? It stops if it is running.`, {confirmLabel: 'Delete', danger: true}))) return
    try { await be.forwards.remove(s.forward.id); await reload() } catch (e) { toast.error(errMsg(e)) }
  }

  const tileClass = (s: ForwardStatus) => (s.state === 'running' ? 'env-dev' : s.state === 'error' ? 'env-prod' : 'env-none')

  return (
    <div className="hosts-page" aria-label="Port forwarding">
      <div className="toolbar">
        <button className="split-btn" aria-label="New forwarding" onClick={onNew}><IconPlus size={14} /> New forwarding</button>
      </div>

      <h3 className="sec-title">Port Forwarding</h3>
      <div className="cards" role="list" aria-label="Port forwards">
        {draft && (
          <div className="card draft" aria-label="New forwarding draft" data-testid="draft-card">
            <span className="tile env-none fw-tile">{TYPE_LABEL[draft.type][0]}</span>
            <div className="meta"><div className="label">{draft.label || `${TYPE_LABEL[draft.type]} Rule`}</div><div className="addr">{TYPE_LABEL[draft.type]} forwarding</div></div>
          </div>
        )}
        {items.map(s => {
          const f = s.forward
          const h = hostOf(f.host_id)
          return (
            <div key={f.id} className="card forward" role="listitem">
              <span className={'tile fw-tile ' + tileClass(s)} title={`${TYPE_LABEL[f.type]} forwarding · ${s.state}`}>{TYPE_LABEL[f.type][0]}</span>
              <div className="meta">
                <div className="label">{forwardTitle(f)}</div>
                <div className="addr">{h?.label ?? 'unknown host'} · {describeForward(f)} · {s.state}{s.error ? ` · ${s.error}` : ''}</div>
                {s.state === 'running' && s.addr && <div className="addr ok">listening on {s.addr}</div>}
              </div>
              <div className="actions always">
                {s.state === 'running'
                  ? <button aria-label={`Stop ${forwardTitle(f)}`} onClick={() => stop(f.id)}>Stop</button>
                  : <button className="primary" aria-label={`Start ${forwardTitle(f)}`} onClick={() => start(f.id)}>Start</button>}
                <button className="icon ghost" aria-label={`Edit ${forwardTitle(f)}`} onClick={() => onEdit(f)}><IconEdit size={14} /></button>
                <button className="icon ghost danger" aria-label={`Delete ${forwardTitle(f)}`} onClick={() => remove(s)}><IconTrash size={14} /></button>
              </div>
            </div>
          )
        })}
      </div>
      {items.length === 0 && !draft && <div className="empty-hint">No port forwards yet. Choose “New forwarding” to add one.</div>}

      {prompt && (
        <div className="modal-back" role="presentation">
          <div className="modal confirm" role="alertdialog" aria-label="Host key confirmation">
            <div className="modal-body">
              <b>Unknown host key for {prompt.p.host}</b>
              <div className="muted">{prompt.p.key_type} fingerprint</div>
              <div className="fp">{prompt.p.fingerprint}</div>
            </div>
            <div className="modal-foot">
              <button onClick={() => be.session.trustHostKey('fwd-' + prompt.id, '')}>Reject</button>
              <button className="primary" onClick={() => be.session.trustHostKey('fwd-' + prompt.id, prompt.p.fingerprint)}>Trust and connect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
