import {FormEvent, useState} from 'react'
import {useBackend} from '../backend'
import {errMsg} from '../util'
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
      <form className="gate-card" onSubmit={submit} aria-label={creating ? 'Create vault' : 'Unlock vault'}>
        <div className="logo">⌘</div>
        <h1>VVTerm</h1>
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
      </form>
    </div>
  )
}
