import {FormEvent, useState} from 'react'
import {DragBar} from '../ui/DragBar'
import {useBackend} from '../backend'
import {errMsg} from '../util'
import {Brand} from '../ui/Brand'
import type {VaultStatus} from '../types'

const MIN = 12

/** First-run vault creation or unlock screen. The password never leaves this component except via the backend call. */
export function UnlockScreen({status, onDone}: {status: VaultStatus; onDone: () => void}) {
  const be = useBackend()
  const creating = !status.exists
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [resetDone, setResetDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr('')
    if (creating) {
      if (pw.length < MIN) return setErr(`Master password must be at least ${MIN} characters`)
      if (pw !== pw2) return setErr('Passwords do not match')
    }
    setBusy(true)
    try {
      await (creating ? be.vault.create(pw) : be.vault.unlock(pw))
      setPw('')
      setPw2('')
      onDone()
    } catch (x) {
      setErr(errMsg(x))
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setErr('')
    setBusy(true)
    try {
      await be.vault.resetVault(confirm)
      setConfirm('')
      setForgot(false)
      setResetDone(true)
      onDone() // the vault no longer exists: this screen turns into the create-vault form
    } catch (x) {
      setErr(errMsg(x))
    } finally {
      setBusy(false)
    }
  }

  const biometric = async () => {
    setErr('')
    try {
      await be.vault.unlockBiometric()
      onDone()
    } catch (x) {
      setErr(errMsg(x))
    }
  }

  return (
    <div className="gate">
      <DragBar />
      <form className="gate-card" onSubmit={submit} aria-label={creating ? 'Create vault' : 'Unlock vault'}>
        <Brand size="lg" heading />
        {resetDone && creating && (
          <div className="notice" role="status">
            The old vault was erased. Choose a new master password. To bring your keys back, restore an encrypted backup from <b>Import / Export</b> after unlocking.
          </div>
        )}
        {forgot ? (
          <div className="forgot" role="group" aria-label="Forgot master password">
            <p><b>Your master password cannot be recovered.</b> It never leaves your Mac, so nobody (including us) can reset it for you.</p>
            <p className="muted">You can <b>reset the vault</b>: this permanently erases every saved key and password, but keeps your hosts, groups, snippets and port forwards. Hosts that used a saved credential will need new ones. If you have an encrypted backup, restore it afterwards from Import / Export.</p>
            <label className="field"><span>Type RESET to confirm</span>
              <input aria-label="Type RESET to confirm" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="off"
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (confirm.trim() === 'RESET' && !busy) void reset() } }} /></label>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="row">
              <button type="button" onClick={() => { setForgot(false); setErr(''); setConfirm('') }}>Back</button>
              <button type="button" className="danger-solid" disabled={busy || confirm.trim() !== 'RESET'} onClick={reset}>Erase vault and start over</button>
            </div>
          </div>
        ) : (<>
        <p className="muted">{creating ? 'Create a vault to store your keys and passwords.' : 'Enter your master password to unlock the vault.'}</p>
        <label className="field">
          <span>Master password</span>
          <input type="password" autoFocus value={pw} onChange={e => setPw(e.target.value)} autoComplete="off" />
        </label>
        {creating && (
          <>
            <label className="field">
              <span>Confirm password</span>
              <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="off" />
            </label>
            <div className="notice">
              If you forget this password the vault cannot be recovered. Export a backup regularly.
            </div>
          </>
        )}
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row" style={{marginTop: 12}}>
          <button className="primary" type="submit" disabled={busy || !pw}>{creating ? 'Create vault' : 'Unlock'}</button>
          {!creating && status.keychain_enabled && (
            <button type="button" onClick={biometric}>Use keychain</button>
          )}
        </div>
        {!creating && <button type="button" className="link forgot-link" onClick={() => { setForgot(true); setErr('') }}>Forgot password?</button>}
        </>)}
      </form>
    </div>
  )
}
