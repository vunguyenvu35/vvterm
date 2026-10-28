import {useEffect, useState} from 'react'
import {Field, Modal} from '../ui/Modal'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {errMsg} from '../util'
import type {Settings, VaultStatus} from '../types'

export function SettingsPanel({vault, onClose, onSettings, onVault}: {vault: VaultStatus; onClose(): void; onSettings(s: Settings): void; onVault(): void}) {
  const be = useBackend()
  const toast = useToast()
  const [s, setS] = useState<Settings | null>(null)
  const [auto, setAuto] = useState(String(vault.auto_lock_minutes))
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { void be.settings.get().then(setS) }, [be])
  if (!s) return null

  const guard = async (fn: () => Promise<void>, ok: string) => {
    setErr('')
    try {
      await fn()
      toast.info(ok)
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="row">
        <Field label="Theme">
          <select aria-label="Theme" value={s.theme} onChange={e => setS({...s, theme: e.target.value as Settings['theme']})}>
            <option value="dark">Dark</option><option value="light">Light</option>
          </select>
        </Field>
        <Field label="Terminal font size"><input aria-label="Font size" type="number" min={8} max={40} value={s.font_size} onChange={e => setS({...s, font_size: Number(e.target.value)})} /></Field>
      </div>
      <button className="primary" onClick={() => guard(async () => { const n = await be.settings.save(s); onSettings(n) }, 'Appearance saved')}>Save appearance</button>

      <div className="section">Vault security</div>
      <div className="row">
        <Field label="Auto-lock after (minutes, 0 = never)"><input aria-label="Auto-lock minutes" value={auto} onChange={e => setAuto(e.target.value)} /></Field>
        <div className="fixed"><button onClick={() => guard(async () => { await be.vault.setAutoLock(Number(auto)); onVault() }, 'Auto-lock updated')}>Apply</button></div>
      </div>
      <div className="row">
        {vault.keychain_enabled
          ? <button onClick={() => guard(async () => { await be.vault.disableBiometric(); onVault() }, 'Keychain unlock disabled')}>Disable keychain unlock</button>
          : <button onClick={() => guard(async () => { await be.vault.enableBiometric(); onVault() }, 'Keychain unlock enabled')}>Enable keychain unlock</button>}
      </div>
      <div className="section">Change master password</div>
      <div className="row">
        <Field label="Current"><input aria-label="Current password" type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} /></Field>
        <Field label="New (min 12 chars)"><input aria-label="New password" type="password" value={newPw} onChange={e => setNewPw(e.target.value)} /></Field>
      </div>
      <button disabled={!oldPw || newPw.length < 12} onClick={() => guard(async () => { await be.vault.changePassword(oldPw, newPw); setOldPw(''); setNewPw('') }, 'Master password changed')}>Change password</button>
      {err && <div className="error" role="alert">{err}</div>}
    </Modal>
  )
}
