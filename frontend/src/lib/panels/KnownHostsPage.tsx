import {useCallback, useEffect, useMemo, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {errMsg} from '../util'
import {IconCopy, IconFingerprint, IconRefresh, IconSearch, IconTrash} from '../ui/Icons'
import type {KnownHost} from '../types'

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

  const shown = useMemo(() => (items ?? []).filter(k => !q.trim() || (k.host + ' ' + k.key_type + ' ' + k.fingerprint).toLowerCase().includes(q.trim().toLowerCase())), [items, q])

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
      <div className="toolbar">
        <div className="search-box small grow"><IconSearch size={14} /><input aria-label="Search known hosts" placeholder="Search known hosts" value={q} onChange={e => setQ(e.target.value)} /></div>
        <button className="ghost-btn" aria-label="Refresh known hosts" onClick={reload}><IconRefresh size={14} /> Refresh</button>
      </div>

      <h3 className="sec-title">Known Hosts</h3>
      <div className="cards" role="list" aria-label="Known hosts">
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
