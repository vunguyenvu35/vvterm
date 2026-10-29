import {useCallback, useEffect, useMemo, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {errMsg} from '../util'
import {IconEdit, IconPlus, IconTrash} from '../ui/Icons'
import {TYPE_LABEL} from './ForwardPanel'
import {byName, FilterChip, ListToolbar, usePref, VIEWS, type SortOption} from '../ui/ListTools'
import type {ForwardStatus, ForwardType, Host, HostKeyPrompt, PortForward} from '../types'

export function describeForward(f: PortForward): string {
  const bind = `${f.bind_addr}:${f.bind_port || 'auto'}`
  if (f.type === 'dynamic') return `SOCKS5 ${bind}`
  return `${bind} → ${f.dest_host}:${f.dest_port}`
}

/** The name on a card: the label, or "Local Rule" style when there is none. */
export const forwardTitle = (f: PortForward) => f.label || `${TYPE_LABEL[f.type]} Rule`

type Sort = 'name' | 'host' | 'type' | 'status' | 'port'
const SORTS: SortOption<Sort>[] = [{value: 'name', label: 'Name'}, {value: 'host', label: 'Host'}, {value: 'type', label: 'Type'}, {value: 'status', label: 'Status (running first)'}, {value: 'port', label: 'Port'}]
const STATE_ORDER: Record<string, number> = {running: 0, error: 1, stopped: 2}

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
  const [q, setQ] = useState('')
  const [states, setStates] = useState<string[]>([])
  const [types, setTypes] = useState<ForwardType[]>([])
  const [sort, setSort] = usePref<Sort>('vvterm.forwards.sort', SORTS.map(o => o.value), 'name')
  const [view, setView] = usePref('vvterm.forwards.view', VIEWS, 'grid')

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

  const presentStates = Array.from(new Set(items.map(s => s.state))).sort((a, b) => STATE_ORDER[a] - STATE_ORDER[b])
  const presentTypes = Array.from(new Set(items.map(s => s.forward.type)))
  const activeStates = states.filter(s => presentStates.includes(s as ForwardStatus['state']))
  const activeTypes = types.filter(t => presentTypes.includes(t))
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const hostLabel = (s: ForwardStatus) => hosts.find(h => h.id === s.forward.host_id)?.label ?? ''
    const list = items.filter(s => (activeStates.length === 0 || activeStates.includes(s.state)) && (activeTypes.length === 0 || activeTypes.includes(s.forward.type)) &&
      (!needle || [forwardTitle(s.forward), hostLabel(s), describeForward(s.forward), TYPE_LABEL[s.forward.type], s.state].join(' ').toLowerCase().includes(needle)))
    const by = (a: ForwardStatus, b: ForwardStatus) => {
      switch (sort) {
        case 'host': return byName(hostLabel(a), hostLabel(b))
        case 'type': return byName(TYPE_LABEL[a.forward.type], TYPE_LABEL[b.forward.type])
        case 'status': return STATE_ORDER[a.state] - STATE_ORDER[b.state]
        case 'port': return (a.forward.bind_port || 1e9) - (b.forward.bind_port || 1e9)
        default: return 0
      }
    }
    return [...list].sort((a, b) => by(a, b) || byName(forwardTitle(a.forward), forwardTitle(b.forward)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hosts, q, sort, activeStates.join(','), activeTypes.join(',')])

  const tileClass = (s: ForwardStatus) => (s.state === 'running' ? 'env-dev' : s.state === 'error' ? 'env-prod' : 'env-none')

  return (
    <div className="hosts-page" aria-label="Port forwarding">
      <div className="toolbar">
        <button className="split-btn" aria-label="New forwarding" onClick={onNew}><IconPlus size={14} /> New forwarding</button>
      </div>
      {items.length > 0 && (
        <ListToolbar what="port forwards" query={q} onQuery={setQ} sort={sort} sortOptions={SORTS} onSort={setSort} view={view} onView={setView}>
          <div className="chips">
            {presentStates.length > 1 && presentStates.map(s => <FilterChip key={s} label={s[0].toUpperCase() + s.slice(1)} dot={s === 'running' ? 'env-dev' : s === 'error' ? 'env-prod' : 'env-none'} on={activeStates.includes(s)} onToggle={() => setStates(activeStates.includes(s) ? activeStates.filter(x => x !== s) : [...activeStates, s])} />)}
            {presentTypes.length > 1 && presentTypes.map(t => <FilterChip key={t} label={TYPE_LABEL[t]} on={activeTypes.includes(t)} onToggle={() => setTypes(activeTypes.includes(t) ? activeTypes.filter(x => x !== t) : [...activeTypes, t])} />)}
          </div>
        </ListToolbar>
      )}

      <h3 className="sec-title">Port Forwarding</h3>
      <div className={'cards' + (view === 'list' ? ' as-list' : '')} role="list" aria-label="Port forwards" data-view={view}>
        {draft && (
          <div className="card draft" aria-label="New forwarding draft" data-testid="draft-card">
            <span className="tile env-none fw-tile">{TYPE_LABEL[draft.type][0]}</span>
            <div className="meta"><div className="label">{draft.label || `${TYPE_LABEL[draft.type]} Rule`}</div><div className="addr">{TYPE_LABEL[draft.type]} forwarding</div></div>
          </div>
        )}
        {shown.map(s => {
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
      {items.length > 0 && shown.length === 0 && <div className="empty-hint">No port forward matches.</div>}
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
