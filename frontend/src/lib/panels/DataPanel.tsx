import {useState} from 'react'
import {Field, Modal} from '../ui/Modal'
import {Select} from '../ui/Select'
import {IconWarn} from '../ui/Icons'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {errMsg} from '../util'
import type {ImportReport} from '../types'

/** Import / export. Nothing is locked in: ssh config, plain metadata JSON and encrypted backups all round-trip. */
export function DataPanel({onClose, onChanged}: {onClose(): void; onChanged(): void}) {
  const be = useBackend()
  const toast = useToast()
  const [cfgPath, setCfgPath] = useState('')
  const [conflict, setConflict] = useState('skip')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [withKeys, setWithKeys] = useState(false)
  const [bpw, setBpw] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const guard = async (fn: () => Promise<void>) => {
    setErr('')
    setMsg('')
    try {
      await fn()
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const choose = async (title: string, kind: 'file' | 'dir' | 'save', name = '') => {
    const p = kind === 'file' ? await be.system.pickFile(title) : kind === 'dir' ? await be.system.pickDirectory(title) : await be.system.saveFile(title, name)
    return p
  }

  return (
    <Modal title="Import & export" wide onClose={onClose}>
      <div className="section">Import ~/.ssh/config</div>
      <div className="row">
        <Field label="Config file"><input aria-label="Config path" value={cfgPath} onChange={e => setCfgPath(e.target.value)} placeholder="~/.ssh/config" /></Field>
        <div className="fixed"><button onClick={() => guard(async () => { const p = await choose('Choose ssh config', 'file'); if (p) setCfgPath(p) })}>Browse…</button></div>
      </div>
      <Field label="If a host with the same name exists">
        <Select label="Conflict policy" value={conflict} onChange={setConflict}
          options={[{value: 'skip', label: 'Skip it'}, {value: 'overwrite', label: 'Overwrite it'}, {value: 'duplicate', label: 'Create a copy'}]} />
      </Field>
      <button className="primary" disabled={!cfgPath} onClick={() => guard(async () => {
        const r = await be.data.importSSHConfig(cfgPath, conflict)
        setReport(r)
        onChanged()
      })}>Import</button>
      {report && (
        <div className="notice" data-testid="import-report">
          Added {report.hosts_added} hosts, {report.groups_added} groups, {report.forwards_added} forwards; imported {report.keys_imported} keys.
          {(report.skipped?.length ?? 0) > 0 && <div>Skipped: {report.skipped.join(', ')}</div>}
          {(report.warnings ?? []).map((w, i) => <div key={i} className="muted warn-line"><IconWarn size={14} /> {w}</div>)}
        </div>
      )}

      <div className="section">Export ssh config</div>
      <label><input type="checkbox" style={{width: 'auto'}} checked={withKeys} onChange={e => setWithKeys(e.target.checked)} /> Also export private keys</label>
      {withKeys && <div className="notice">Private keys will be written to disk unencrypted (mode 0600). Only do this to a location you trust.</div>}
      <div style={{marginTop: 8}}>
        <button onClick={() => guard(async () => {
          const dir = await choose('Export folder', 'dir')
          if (!dir) return
          const r = await be.data.exportSSHConfig(dir, withKeys)
          setMsg(`Wrote ${(r.files ?? []).length} config file(s) and ${(r.key_files ?? []).length} key file(s).${r.warnings?.length ? ' Warnings: ' + r.warnings.join('; ') : ''}`)
        })}>Export…</button>{' '}
        <button onClick={() => guard(async () => {
          const p = await choose('Save host list', 'save', 'vvterm-hosts.json')
          if (!p) return
          await be.data.exportPlainJSON(p)
          setMsg('Host list (no secrets) exported.')
        })}>Export host list (JSON, no secrets)</button>
      </div>

      <div className="section">Encrypted backup</div>
      <Field label="Backup password (separate from your master password)"><input aria-label="Backup password" type="password" value={bpw} onChange={e => setBpw(e.target.value)} /></Field>
      <button disabled={bpw.length < 8} onClick={() => guard(async () => {
        const p = await choose('Save backup', 'save', 'vvterm.vvbak')
        if (!p) return
        await be.data.exportBackup(p, bpw)
        setMsg('Backup written.')
      })}>Export backup…</button>{' '}
      <button disabled={!bpw} onClick={() => guard(async () => {
        const p = await choose('Choose backup', 'file')
        if (!p) return
        await be.data.importBackup(p, bpw)
        onChanged()
        toast.info('Backup restored')
      })}>Restore backup…</button>
      {bpw.length > 0 && bpw.length < 8 && <div className="muted">At least 8 characters.</div>}

      {msg && <div className="ok" role="status" style={{marginTop: 10}}>{msg}</div>}
      {err && <div className="error" role="alert">{err}</div>}
    </Modal>
  )
}
