import {useMemo, useState} from 'react'
import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {useBackend} from '../backend'
import {errMsg} from '../util'
import {IconCopy, IconKey, IconLock, IconPlus, IconTrash, IconUser} from '../ui/Icons'
import {byName, FilterChip, ListToolbar, usePref, VIEWS, type SortOption} from '../ui/ListTools'
import type {AuthType, Identity} from '../types'

type Sort = 'name' | 'name-desc' | 'type'
const SORTS: SortOption<Sort>[] = [{value: 'name', label: 'Name A–Z'}, {value: 'name-desc', label: 'Name Z–A'}, {value: 'type', label: 'Type'}]
const KINDS: {id: AuthType; label: string}[] = [{id: 'key', label: 'Keys'}, {id: 'password', label: 'Passwords'}, {id: 'agent', label: 'ssh-agent'}]

export type KeyMode = 'key' | 'generate' | 'password' | 'agent'

/** "ED25519", "RSA"… from the public key; password and agent identities say what they are. */
export function keyType(i: Pick<Identity, 'auth_type' | 'public_key'>): string {
  const pk = i.public_key ?? ''
  if (pk.startsWith('ssh-ed25519')) return 'ED25519'
  if (pk.startsWith('ssh-rsa')) return 'RSA'
  if (pk.startsWith('ecdsa-')) return 'ECDSA'
  if (pk.startsWith('ssh-dss')) return 'DSA'
  return ({key: 'Key', password: 'Password', agent: 'ssh-agent'} as Record<string, string>)[i.auth_type] ?? i.auth_type
}

interface Props {
  identities: Identity[]
  /** label typed in the New key panel: shown as a highlighted draft card. `undefined` = no draft. */
  draft?: string
  onNew(mode: KeyMode): void
  onChanged(): void
}

/** Keychain, like Termius: a toolbar, then one card per key, password or agent identity. */
export function KeychainPage({identities, draft, onNew, onChanged}: Props) {
  const be = useBackend()
  const toast = useToast()
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [kinds, setKinds] = useState<AuthType[]>([])
  const [sort, setSort] = usePref<Sort>('vvterm.keychain.sort', SORTS.map(o => o.value), 'name')
  const [view, setView] = usePref('vvterm.keychain.view', VIEWS, 'grid')
  const present = KINDS.filter(k => identities.some(i => i.auth_type === k.id))
  const activeKinds = kinds.filter(k => present.some(x => x.id === k))
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = identities.filter(i => (activeKinds.length === 0 || activeKinds.includes(i.auth_type)) &&
      (!needle || (i.name + ' ' + (i.username ?? '') + ' ' + keyType(i)).toLowerCase().includes(needle)))
    return [...list].sort((a, b) => (sort === 'type' ? byName(keyType(a), keyType(b)) || byName(a.name, b.name) : sort === 'name' ? byName(a.name, b.name) : byName(b.name, a.name)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identities, q, sort, activeKinds.join(',')])

  const remove = async (i: Identity) => {
    if (!(await confirm(`Delete identity "${i.name}"? Its secret is removed from the vault.`, {confirmLabel: 'Delete', danger: true}))) return
    try {
      await be.vault.deleteIdentity(i.id)
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
  const icon = (i: Identity) => (i.auth_type === 'password' ? <IconLock size={20} /> : i.auth_type === 'agent' ? <IconUser size={20} /> : <IconKey size={20} />)

  return (
    <div className="hosts-page" aria-label="Keychain">
      <div className="toolbar">
        <button className="split-btn" aria-label="New key" onClick={() => onNew('key')}><IconPlus size={14} /> New key</button>
        <button className="ghost-btn" aria-label="Generate key" onClick={() => onNew('generate')}><IconKey size={14} /> Generate key</button>
        <button className="ghost-btn" aria-label="New password" onClick={() => onNew('password')}><IconLock size={14} /> Password</button>
        <button className="ghost-btn" aria-label="New ssh-agent identity" onClick={() => onNew('agent')}><IconUser size={14} /> ssh-agent</button>
      </div>

      {identities.length > 0 && (
        <ListToolbar what="keys" query={q} onQuery={setQ} sort={sort} sortOptions={SORTS} onSort={setSort} view={view} onView={setView}>
          {present.length > 1 && <div className="chips">{present.map(k => <FilterChip key={k.id} label={k.label} on={activeKinds.includes(k.id)} onToggle={() => setKinds(activeKinds.includes(k.id) ? activeKinds.filter(x => x !== k.id) : [...activeKinds, k.id])} />)}</div>}
        </ListToolbar>
      )}
      <h3 className="sec-title">Keys</h3>
      <div className={'cards' + (view === 'list' ? ' as-list' : '')} role="list" aria-label="Identities" data-view={view}>
        {draft !== undefined && (
          <div className="card draft" aria-label="New key draft" data-testid="draft-card">
            <span className="tile key-tile"><IconKey size={20} /></span>
            <div className="meta"><div className="label">{draft || 'Add a label…'}</div><div className="addr">Type unknown</div></div>
          </div>
        )}
        {shown.map(i => (
          <div key={i.id} className="card" role="listitem">
            <span className="tile key-tile">{icon(i)}</span>
            <div className="meta">
              <div className="label">{i.name}</div>
              <div className="addr">Type {keyType(i)}{i.certificate ? ' · certificate' : ''}{i.username ? ` · ${i.username}` : ''}</div>
            </div>
            <div className="actions">
              {i.public_key && <button className="icon ghost" aria-label={`Copy public key of ${i.name}`} title="Copy public key" onClick={() => copy(i.public_key!)}><IconCopy size={14} /></button>}
              <button className="icon ghost danger" aria-label={`Delete ${i.name}`} onClick={() => remove(i)}><IconTrash size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {identities.length > 0 && shown.length === 0 && <div className="empty-hint">No key matches.</div>}
      {identities.length === 0 && draft === undefined && <div className="empty-hint">No keys yet. Import a private key, generate one, or save a password.</div>}
    </div>
  )
}
