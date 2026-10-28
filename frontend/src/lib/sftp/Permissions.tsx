import {useState} from 'react'
import {Modal} from '../ui/Modal'

const WHO = ['Owner', 'Group', 'Others'] as const
const WHAT = ['Read', 'Write', 'Execute'] as const

/** "drwxr-xr-x" or "-rw-r--r--" to 0o755 / 0o644 (setuid, setgid and sticky are kept as they are shown). */
export function parseMode(s: string | undefined): number {
  if (!s || s.length < 10) return 0o644
  let m = 0
  for (let i = 0; i < 9; i++) {
    const c = s[1 + i]
    if (c !== '-') m |= 1 << (8 - i)
  }
  return m
}

/** 0o755 to "rwxr-xr-x". */
export function formatMode(m: number): string {
  return Array.from({length: 9}, (_, i) => (m & (1 << (8 - i)) ? 'rwx'[i % 3] : '-')).join('')
}

interface Props {
  name: string
  mode: string
  onSave(mode: number): Promise<void> | void
  onClose(): void
}

/** Edit Permissions: a grid of read / write / execute for owner, group and others, and the same as an octal number. */
export function PermissionsDialog({name, mode, onSave, onClose}: Props) {
  const [m, setM] = useState(parseMode(mode))
  const [text, setText] = useState(parseMode(mode).toString(8).padStart(3, '0'))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const change = (n: number) => { setM(n); setText(n.toString(8).padStart(3, '0')) }
  const toggle = (who: number, what: number) => change(m ^ (1 << (8 - (who * 3 + what))))
  // the octal box can be emptied while typing; the grid follows once there are three digits
  const setOctal = (v: string) => { if (/^[0-7]{0,3}$/.test(v)) { setText(v); if (v.length === 3) setM(parseInt(v, 8)) } }
  const save = async () => {
    setBusy(true)
    setErr('')
    try { await onSave(m) } catch (e) { setErr(String((e as Error)?.message ?? e)); setBusy(false); return }
    onClose()
  }
  return (
    <Modal title={`Permissions of ${name}`} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={save}>Save</button></>}>
      <table className="perm-grid" aria-label="Permissions">
        <thead><tr><th />{WHAT.map(w => <th key={w}>{w}</th>)}</tr></thead>
        <tbody>
          {WHO.map((who, wi) => (
            <tr key={who}>
              <th scope="row">{who}</th>
              {WHAT.map((what, ti) => (
                <td key={what}><input type="checkbox" aria-label={`${who} ${what.toLowerCase()}`} checked={!!(m & (1 << (8 - (wi * 3 + ti))))} onChange={() => toggle(wi, ti)} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="perm-octal">
        <label>Octal <input aria-label="Octal permissions" value={text} onChange={e => setOctal(e.target.value)} inputMode="numeric" maxLength={3} /></label>
        <code>{formatMode(m)}</code>
      </div>
      {err && <div className="error" role="alert">{err}</div>}
    </Modal>
  )
}
