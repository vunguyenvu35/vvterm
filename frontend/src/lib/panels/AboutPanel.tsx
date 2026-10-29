import {useCallback, useEffect, useState} from 'react'
import {Modal} from '../ui/Modal'
import {Brand} from '../ui/Brand'
import {useBackend, type UpdateInfo} from '../backend'
import {errMsg} from '../util'

const REPO = 'https://github.com/vunguyenvu35/vvterm'

/** About VVTerm: version, what it is, the project's links, and a check for a newer release on GitHub. */
export function AboutPanel({onClose, checkNow = false}: {onClose(): void; checkNow?: boolean}) {
  const be = useBackend()
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<UpdateInfo | null>(null)
  const [err, setErr] = useState('')

  const check = useCallback(async () => {
    setBusy(true)
    setErr('')
    try { setResult(await be.system.checkUpdate()) } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }, [be])

  useEffect(() => { void be.system.info().then(i => setVersion(i.version)).catch(() => {}) }, [be])
  useEffect(() => { if (checkNow) void check() }, [checkNow, check])

  return (
    <Modal title="About VVTerm" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <div style={{textAlign: 'center', display: 'grid', gap: 10, justifyItems: 'center'}}>
        <Brand size="lg" />
        <div>Version <b data-testid="about-version">{version || '…'}</b></div>
        <div className="muted">An SSH client for people who want to own their data. Free and open source (MIT). Your hosts, keys and snippets stay on this computer.</div>
        <div className="muted">Made by Vu Nguyen Vu.</div>
        {busy && <div className="muted" role="status">Checking for updates…</div>}
        {err && <div className="error" role="alert">{err}</div>}
        {result && !busy && (result.available
          ? <div role="status">Version <b>{result.latest}</b> is available. <button className="link" onClick={() => void be.system.openUrl(result.url)}>Open the release page</button></div>
          : <div className="muted" role="status">You are on the latest version.</div>)}
        <div>
          <button disabled={busy} onClick={() => void check()}>Check for updates</button>
        </div>
        <div className="muted">
          <button className="link" onClick={() => void be.system.openUrl(REPO)}>GitHub</button>{' · '}
          <button className="link" onClick={() => void be.system.openUrl(REPO + '/issues/new')}>Report a bug</button>{' · '}
          <button className="link" onClick={() => void be.system.openUrl(REPO + '/blob/main/LICENSE')}>License</button>{' · '}
          <button className="link" onClick={() => void be.system.openUrl('https://ko-fi.com/vunguyenvu')}>Support</button>
        </div>
      </div>
    </Modal>
  )
}
