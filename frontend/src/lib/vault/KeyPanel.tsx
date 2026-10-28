import {DragEvent, useRef, useState} from 'react'
import {Section, SidePanel} from '../ui/Modal'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {errMsg} from '../util'
import {IconUpload} from '../ui/Icons'
import type {KeyMode} from './KeychainPage'
import type {Identity} from '../types'

const MAX_KEY_FILE = 256 * 1024

/** Reads a dropped or chosen key file as text (a private key is a few KiB; anything big is not one). */
export async function readKeyFile(file: File): Promise<string> {
  if (file.size > MAX_KEY_FILE) throw new Error('That file is too large to be a private key')
  const text = await (typeof file.text === 'function' ? file.text() : new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsText(file)
  }))
  if (!/PRIVATE KEY/.test(text)) throw new Error('That does not look like a private key file')
  return text
}

const TITLES: Record<KeyMode, string> = {key: 'New Key', generate: 'Generate Key', password: 'New Password', agent: 'New ssh-agent identity'}

interface Props {
  mode: KeyMode
  onClose(): void
  /** something was saved: refresh the list */
  onChanged(): void
  /** the label as it is typed, for the draft card */
  onDraft(label: string): void
}

/** The docked panel next to the Keychain list: import a key (paste, drop a file or choose one), generate one, or add a password / agent identity. */
export function KeyPanel({mode, onClose, onChanged, onDraft}: Props) {
  const be = useBackend()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [label, setLabelState] = useState('')
  const [pem, setPem] = useState('')
  const [pass, setPass] = useState('')
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<Identity | null>(null)

  const setLabel = (v: string) => { setLabelState(v); onDraft(v) }

  const run = async (fn: () => Promise<Identity | void>, ok: string, keepOpen = false) => {
    setErr('')
    setBusy(true)
    try {
      const r = await fn()
      onChanged()
      toast.info(ok)
      if (keepOpen && r) setCreated(r as Identity)
      else onClose()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const takeFile = async (file: File | undefined) => {
    if (!file) return
    setErr('')
    try {
      setPem(await readKeyFile(file))
      if (!label.trim()) setLabel(file.name.replace(/\.(pem|key|pub)$/i, ''))
    } catch (e) {
      setErr(errMsg(e))
    }
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void takeFile(e.dataTransfer.files?.[0])
  }
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.info('Public key copied') } catch { toast.error('Clipboard not available') }
  }

  const labelBox = (
    <input aria-label="Label" value={label} onChange={e => setLabel(e.target.value)} placeholder="Label" autoFocus />
  )

  let body, footer
  if (mode === 'key') {
    body = (
      <>
        <Section>
          {labelBox}
          <textarea aria-label="Private key" className="key-area" rows={5} spellCheck={false} value={pem} onChange={e => setPem(e.target.value)}
            placeholder="Private key (-----BEGIN OPENSSH PRIVATE KEY-----)" />
          <input aria-label="Passphrase" type="password" autoComplete="off" value={pass} onChange={e => setPass(e.target.value)} placeholder="Passphrase (only if the key is encrypted)" />
          <div className="muted">The public key is worked out from the private key. The private key is stored encrypted in the vault and never shown again.</div>
        </Section>
        <Section>
          <div className={'drop-zone' + (over ? ' over' : '')} data-testid="key-drop" onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop}>
            <IconUpload size={26} />
            <span>Drag and drop a private key file to import</span>
          </div>
          <input ref={fileInput} type="file" hidden aria-label="Key file" onChange={e => { void takeFile(e.target.files?.[0]); e.target.value = '' }} />
          <button className="primary wide-btn" onClick={() => fileInput.current?.click()}>Import from key file</button>
        </Section>
      </>
    )
    footer = (
      <>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !label.trim() || !pem.trim()} onClick={() => run(() => be.vault.addKeyPEM(label.trim(), pem, pass), 'Key saved')}>Save key</button>
      </>
    )
  } else if (mode === 'generate') {
    body = created ? (
      <Section title="Public key">
        <p className="ok">Key “{created.name}” created. Add this public key to <code>~/.ssh/authorized_keys</code> on your servers:</p>
        <div className="pubkey" data-testid="pubkey">{created.public_key}</div>
        <button onClick={() => copy(created.public_key!)}>Copy public key</button>
      </Section>
    ) : (
      <Section>
        {labelBox}
        <div className="muted">Generates an ed25519 key pair. The private key stays encrypted in the vault and is never shown.</div>
      </Section>
    )
    footer = created
      ? <button className="primary" onClick={onClose}>Done</button>
      : <><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !label.trim()} onClick={() => run(() => be.vault.generateKey(label.trim()), 'Key generated', true)}>Generate</button></>
  } else if (mode === 'password') {
    body = (
      <Section>
        {labelBox}
        <input aria-label="Username" value={user} onChange={e => setUser(e.target.value)} placeholder="Username" />
        <input aria-label="Password" type="password" autoComplete="off" value={pw} onChange={e => setPw(e.target.value)} placeholder="Password" />
      </Section>
    )
    footer = <><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !label.trim() || !pw} onClick={() => run(() => be.vault.addPassword(label.trim(), user, pw), 'Password saved')}>Save password</button></>
  } else {
    body = (
      <Section>
        {labelBox}
        <input aria-label="Username" value={user} onChange={e => setUser(e.target.value)} placeholder="Username" />
        <div className="muted">Authenticates with the keys loaded in your running ssh-agent.</div>
      </Section>
    )
    footer = <><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !label.trim()} onClick={() => run(() => be.vault.addAgent(label.trim(), user), 'Agent identity added')}>Add identity</button></>
  }

  return (
    <SidePanel title={TITLES[mode]} onClose={onClose} footer={footer}>
      {body}
      {err && <div className="error" role="alert">{err}</div>}
    </SidePanel>
  )
}
