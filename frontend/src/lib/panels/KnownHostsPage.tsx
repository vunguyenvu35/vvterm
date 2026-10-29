import {useCallback, useEffect, useMemo, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {errMsg} from '../util'
import {IconCopy, IconFingerprint, IconRefresh, IconTrash} from '../ui/Icons'
import {byName, FilterChip, ListToolbar, usePref, VIEWS, type SortOption} from '../ui/ListTools'
import type {KnownHost} from '../types'

type Sort = 'host' | 'host-desc' | 'type'
const SORTS: SortOption<Sort>[] = [{value: 'host', label: 'Host A–Z'}, {value: 'host-desc', label: 'Host Z–A'}, {value: 'type', label: 'Key type'}]

/**
 * Known Hosts: the machines whose key you trusted (first connection, or the trust prompt). Forgetting one
 * does not delete the host from the app: the next connection simply asks to trust its key again, which is
 * what to do after a server was reinstalled and legitimately has a new key.
 */
export function KnownHostsPage() {
  const be = useBackend()
  const toast = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState<KnownHost[] | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [types, setTypes] = useState<string[]>([])
  const [sort, setSort] = usePref<Sort>('vvterm.knownhosts.sort', SORTS.map(o => o.value), 'host')
  const [view, setView] = usePref('vvterm.knownhosts.view', VIEWS, 'grid')

  const reload = useCallback(async () => {
    try {
      setItems((await be.knownHosts.list()) ?? [])
      setError('')
    } catch (e) {
      setItems([])
      setError(errMsg(e))
    }
  }, [be])
  useEffect(() => {
    void reload()
    return be.on('log:added', () => void reload()) // a new key was trusted, or one was forgotten
  }, [be, reload])

  const presentTypes = useMemo(() => Array.from(new Set((items ?? []).map(k => k.key_type))).sort(byName), [items])
  const activeTypes = types.filter(t => presentTypes.includes(t))
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = (items ?? []).filter(k => (activeTypes.length === 0 || activeTypes.includes(k.key_type)) && (!needle || (k.host + ' ' + k.key_type + ' ' + k.fingerprint).toLowerCase().includes(needle)))
    return [...list].sort((a, b) => (sort === 'host-desc' ? byName(b.host, a.host) : sort === 'type' ? byName(a.key_type, b.key_type) || byName(a.host, b.host) : byName(a.host, b.host)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q, sort, activeTypes.join(',')])

  const forget = async (k: KnownHost) => {
    if (!(await confirm(`Forget ${k.host}? VVTerm will ask whether to trust its key again the next time you connect.`, {confirmLabel: 'Forget', danger: true}))) return
    try {
      await be.knownHosts.forget(k.host, k.fingerprint)
      toast.info(`Forgot ${k.host}`)
      await reload()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.info('Fingerprint copied')
    } catch {
      toast.error('Clipboard not available')
    }
  }

  return (
    <div className="hosts-page" aria-label="Known hosts">
      <ListToolbar what="known hosts" query={q} onQuery={setQ} sort={sort} sortOptions={SORTS} onSort={setSort} view={view} onView={setView}>
        {presentTypes.length > 1 && <div className="chips">{presentTypes.map(t => <FilterChip key={t} label={t} on={activeTypes.includes(t)} onToggle={() => setTypes(activeTypes.includes(t) ? activeTypes.filter(x => x !== t) : [...activeTypes, t])} />)}</div>}
        <button className="ghost-btn" aria-label="Refresh known hosts" onClick={reload}><IconRefresh size={14} /> Refresh</button>
      </ListToolbar>

      <h3 className="sec-title">Known Hosts</h3>
      <div className={'cards' + (view === 'list' ? ' as-list' : '')} role="list" aria-label="Known hosts" data-view={view}>
        {shown.map(k => (
          <div key={k.host + k.fingerprint} className="card" role="listitem">
            <span className="tile key-tile"><IconFingerprint size={20} /></span>
            <div className="meta">
              <div className="label">{k.host}</div>
              <div className="addr" title={k.fingerprint}>{k.key_type} · {k.fingerprint}</div>
            </div>
            <div className="actions">
              <button className="icon ghost" aria-label={`Copy fingerprint of ${k.host}`} title="Copy fingerprint" onClick={() => copy(k.fingerprint)}><IconCopy size={14} /></button>
              <button className="icon ghost danger" aria-label={`Forget ${k.host}`} title="Forget this host key" disabled={k.host === '(hashed)'} onClick={() => forget(k)}><IconTrash size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {items && items.length === 0 && !error && <div className="empty-hint">No trusted hosts yet. A host appears here the first time you trust its key.</div>}
      {items && items.length > 0 && shown.length === 0 && <div className="empty-hint">No host matches.</div>}
      {items?.some(k => k.host === '(hashed)') && <div className="muted fw-hint">Hashed entries (from <code>HashKnownHosts</code>) cannot be named, so they cannot be forgotten here.</div>}
    </div>
  )
}
