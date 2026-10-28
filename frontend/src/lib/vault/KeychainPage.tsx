import {useToast} from '../ui/Toast'
import {useConfirm} from '../ui/Confirm'
import {useBackend} from '../backend'
import {errMsg} from '../util'
import {IconCopy, IconKey, IconLock, IconPlus, IconTrash, IconUser} from '../ui/Icons'
import type {Identity} from '../types'

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

      <h3 className="sec-title">Keys</h3>
      <div className="cards" role="list" aria-label="Identities">
        {draft !== undefined && (
          <div className="card draft" aria-label="New key draft" data-testid="draft-card">
            <span className="tile key-tile"><IconKey size={20} /></span>
            <div className="meta"><div className="label">{draft || 'Add a label…'}</div><div className="addr">Type unknown</div></div>
          </div>
        )}
        {identities.map(i => (
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
      {identities.length === 0 && draft === undefined && <div className="empty-hint">No keys yet. Import a private key, generate one, or save a password.</div>}
    </div>
  )
}
