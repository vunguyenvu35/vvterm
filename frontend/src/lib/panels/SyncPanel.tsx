import {useCallback, useEffect, useState} from 'react'
import {Field, Modal} from '../ui/Modal'
import {useBackend} from '../backend'
import {errMsg} from '../util'
import type {SyncStatus, VaultStatus} from '../types'

/** Git sync. The repo only ever receives bundle.enc and vault-header.json (ciphertext). */
export function SyncPanel({vault, onClose, onChanged}: {vault: VaultStatus; onClose(): void; onChanged(): void}) {
  const be = useBackend()
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [url, setUrl] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const s = await be.sync.status()
    setSt(s)
    setUrl(u => u || s.repo_url)
  }, [be])
  useEffect(() => { void load() }, [load])

  const run = async (fn: () => Promise<void>) => {
    setErr('')
    setBusy(true)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
      void load()
    }
  }

  return (
    <Modal title="Sync via Git" onClose={onClose}>
      <p className="muted">Sync your encrypted hosts and keys through a private Git repository you own. Authentication uses your ssh-agent or git credential helper.</p>
      <Field label="Repository URL"><input aria-label="Repository URL" value={url} onChange={e => setUrl(e.target.value)} placeholder="git@github.com:you/vvterm-sync.git" /></Field>
      <div className="row">
        <button disabled={busy || !url.trim()} onClick={() => run(() => be.sync.configure(url.trim()))}>Save repository</button>
        <button className="primary" disabled={busy || !st?.configured || !vault.unlocked} onClick={() => run(() => be.sync.syncNow())}>{busy ? 'Syncing…' : 'Sync now'}</button>
      </div>
      {st && (
        <p className="muted" data-testid="sync-status">
          {st.configured ? 'Configured.' : 'Not configured.'}{' '}
          {st.last_sync && !st.last_sync.startsWith('0001') ? `Last sync: ${new Date(st.last_sync).toLocaleString()}` : 'Never synced.'}
          {st.last_error && <span className="error"> {st.last_error}</span>}
        </p>
      )}
      <div className="section">New machine?</div>
      <p className="muted">If the repository already holds a bundle, enter its master password to restore everything on this machine (only possible before creating a local vault).</p>
      <Field label="Master password of the synced vault"><input aria-label="Synced master password" type="password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
      <button disabled={busy || !st?.configured || vault.exists || !pw} onClick={() => run(() => be.sync.join(pw))}>Restore from repository</button>
      {err && <div className="error" role="alert">{err}</div>}
    </Modal>
  )
}
