import {useCallback, useEffect, useState} from 'react'
import {Field, Modal} from '../ui/Modal'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {errMsg} from '../util'
import type {Identity} from '../types'

type Mode = 'list' | 'generate' | 'key' | 'password' | 'agent'

/** Vault UI: manage identities. Private keys and passwords go in; only metadata and public keys come out. */
export function IdentitiesPanel({onClose, onChanged}: {onClose(): void; onChanged(): void}) {
  const be = useBackend()
  const toast = useToast()
  const [items, setItems] = useState<Identity[]>([])
  const [mode, setMode] = useState<Mode>('list')
  const [err, setErr] = useState('')
  const [created, setCreated] = useState<Identity | null>(null)
  const [f, setF] = useState({name: '', user: '', pw: '', pem: '', pass: '', path: ''})
  const set = (k: keyof typeof f) => (e: {target: {value: string}}) => setF({...f, [k]: e.target.value})

  const reload = useCallback(async () => setItems(await be.vault.listIdentities()), [be])
  useEffect(() => { void reload() }, [reload])

  const run = async (fn: () => Promise<Identity | void>, okMsg: string) => {
    setErr('')
    try {
      const r = await fn()
      await reload()
      onChanged()
      setF({name: '', user: '', pw: '', pem: '', pass: '', path: ''})
      toast.info(okMsg)
      if (r && (r as Identity).public_key && mode === 'generate') setCreated(r as Identity)
      else setMode('list')
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const pick = async () => {
    try {
      const p = await be.system.pickFile('Choose a private key')
      if (p) setF(x => ({...x, path: p}))
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const remove = async (i: Identity) => {
    if (!window.confirm(`Delete identity "${i.name}"? Its secret is removed from the vault.`)) return
    try {
      await be.vault.deleteIdentity(i.id)
      await reload()
      onChanged()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.info('Public key copied')
    } catch {
      toast.error('Clipboard not available')
    }
  }

  return (
    <Modal title="Vault · Identities" wide onClose={onClose}>
      <div className="tabs" role="tablist">
        {(['list', 'generate', 'key', 'password', 'agent'] as Mode[]).map(m => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'primary' : ''} onClick={() => { setMode(m); setErr(''); setCreated(null) }}>
            {({list: 'Identities', generate: 'Generate key', key: 'Import key', password: 'Add password', agent: 'ssh-agent'} as const)[m]}
          </button>
        ))}
      </div>

      {mode === 'list' && (
        <table className="list">
          <thead><tr><th>Name</th><th>Type</th><th>Public key</th><th /></tr></thead>
          <tbody>
            {items.map(i => (
              <tr key={i.id}>
                <td>{i.name}</td>
                <td><span className="badge">{i.auth_type}</span></td>
                <td className="muted">{i.public_key ? i.public_key.slice(0, 32) + '…' : '—'}</td>
                <td style={{textAlign: 'right', whiteSpace: 'nowrap'}}>
                  {i.public_key && <button className="icon" onClick={() => copy(i.public_key!)}>Copy public key</button>}{' '}
                  <button className="icon danger" aria-label={`Delete ${i.name}`} onClick={() => remove(i)}>Delete</button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="muted">No identities yet.</td></tr>}
          </tbody>
        </table>
      )}

      {mode === 'generate' && (created ? (
        <div>
          <p className="ok">Key “{created.name}” created. Add this public key to <code>~/.ssh/authorized_keys</code> on your servers:</p>
          <div className="pubkey" data-testid="pubkey">{created.public_key}</div>
          <div className="row" style={{marginTop: 10}}>
            <button onClick={() => copy(created.public_key!)}>Copy</button>
            <button onClick={() => { setCreated(null); setMode('list') }}>Done</button>
          </div>
        </div>
      ) : (
        <>
          <Field label="Name"><input aria-label="Key name" value={f.name} onChange={set('name')} /></Field>
          <p className="muted">Generates an ed25519 key pair. The private key stays encrypted in the vault and is never shown.</p>
          <button className="primary" disabled={!f.name.trim()} onClick={() => run(() => be.vault.generateKey(f.name.trim()), 'Key generated')}>Generate</button>
        </>
      ))}

      {mode === 'key' && (
        <>
          <Field label="Name"><input aria-label="Key name" value={f.name} onChange={set('name')} /></Field>
          <Field label="Key file">
            <div className="row"><input aria-label="Key file path" value={f.path} onChange={set('path')} placeholder="~/.ssh/id_ed25519" /><button className="fixed" onClick={pick}>Browse…</button></div>
          </Field>
          <Field label="…or paste the private key"><textarea aria-label="Private key" rows={5} value={f.pem} onChange={set('pem')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></Field>
          <Field label="Passphrase (if the key is encrypted)"><input aria-label="Passphrase" type="password" value={f.pass} onChange={set('pass')} /></Field>
          <button className="primary" disabled={!f.name.trim() || (!f.path && !f.pem)}
            onClick={() => run(() => f.pem ? be.vault.addKeyPEM(f.name.trim(), f.pem, f.pass) : be.vault.addKey(f.name.trim(), f.path, f.pass), 'Key imported')}>Import</button>
        </>
      )}

      {mode === 'password' && (
        <>
          <Field label="Name"><input aria-label="Identity name" value={f.name} onChange={set('name')} /></Field>
          <Field label="Username"><input aria-label="Username" value={f.user} onChange={set('user')} /></Field>
          <Field label="Password"><input aria-label="Password" type="password" value={f.pw} onChange={set('pw')} autoComplete="off" /></Field>
          <button className="primary" disabled={!f.name.trim() || !f.pw} onClick={() => run(() => be.vault.addPassword(f.name.trim(), f.user, f.pw), 'Password saved')}>Save</button>
        </>
      )}

      {mode === 'agent' && (
        <>
          <Field label="Name"><input aria-label="Identity name" value={f.name} onChange={set('name')} /></Field>
          <Field label="Username"><input aria-label="Username" value={f.user} onChange={set('user')} /></Field>
          <p className="muted">Authenticates with the keys loaded in your running ssh-agent.</p>
          <button className="primary" disabled={!f.name.trim()} onClick={() => run(() => be.vault.addAgent(f.name.trim(), f.user), 'Agent identity added')}>Add</button>
        </>
      )}
      {err && <div className="error" role="alert">{err}</div>}
    </Modal>
  )
}
