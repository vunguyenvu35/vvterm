import {useCallback, useEffect, useState} from 'react'
import {Field, Modal} from '../ui/Modal'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {errMsg} from '../util'
import type {ForwardStatus, ForwardType, Host, HostKeyPrompt} from '../types'

function describe(s: ForwardStatus): string {
  const f = s.forward
  const bind = `${f.bind_addr}:${f.bind_port || 'auto'}`
  if (f.type === 'dynamic') return `SOCKS5 ${bind}`
  return `${bind} → ${f.dest_host}:${f.dest_port}`
}

/** Port forwards of one host. Start may need a host key confirmation when no terminal is open on the host. */
export function ForwardsPanel({host, onClose}: {host: Host; onClose(): void}) {
  const be = useBackend()
  const toast = useToast()
  const [items, setItems] = useState<ForwardStatus[]>([])
  const [prompt, setPrompt] = useState<{id: string; p: HostKeyPrompt} | null>(null)
  const [err, setErr] = useState('')
  const [f, setF] = useState({type: 'local' as ForwardType, bind_addr: '127.0.0.1', bind_port: '', dest_host: '', dest_port: '', auto_start: false, pub: false})

  const reload = useCallback(async () => setItems((await be.forwards.list()).filter(s => s.forward.host_id === host.id)), [be, host.id])
  useEffect(() => {
    void reload()
    return be.on('forward:state', () => void reload())
  }, [be, reload])

  const start = async (id: string) => {
    const off = be.on('term:hostkey:fwd-' + id, (p: HostKeyPrompt) => setPrompt({id, p}))
    try {
      await be.forwards.start(id)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      off()
      setPrompt(null)
      void reload()
    }
  }

  const add = async () => {
    setErr('')
    try {
      await be.forwards.save({
        host_id: host.id, type: f.type, bind_addr: f.bind_addr, bind_port: Number(f.bind_port) || 0,
        dest_host: f.dest_host, dest_port: Number(f.dest_port) || 0, auto_start: f.auto_start, allow_public_bind: f.pub,
      })
      setF({...f, bind_port: '', dest_host: '', dest_port: ''})
      await reload()
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  return (
    <Modal title={`Port forwards · ${host.label}`} wide onClose={onClose}>
      <table className="list">
        <thead><tr><th>Type</th><th>Mapping</th><th>State</th><th /></tr></thead>
        <tbody>
          {items.map(s => (
            <tr key={s.forward.id}>
              <td><span className="badge">{s.forward.type}</span>{s.forward.auto_start && <span className="badge" title="Starts with the terminal"> auto</span>}</td>
              <td>{describe(s)}{s.state === 'running' && s.addr && <div className="muted">listening on {s.addr}</div>}</td>
              <td className={s.state === 'running' ? 'ok' : s.state === 'error' ? 'error' : 'muted'} title={s.error}>{s.state}</td>
              <td style={{textAlign: 'right', whiteSpace: 'nowrap'}}>
                {s.state === 'running'
                  ? <button onClick={() => be.forwards.stop(s.forward.id).then(reload).catch(e => toast.error(errMsg(e)))}>Stop</button>
                  : <button className="primary" onClick={() => start(s.forward.id)}>Start</button>}{' '}
                <button className="danger" aria-label="Delete forward" onClick={() => be.forwards.remove(s.forward.id).then(reload)}>Delete</button>
              </td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={4} className="muted">No forwards for this host.</td></tr>}
        </tbody>
      </table>

      {prompt && (
        <div className="notice" role="alertdialog">
          <b>Unknown host key for {prompt.p.host}</b>
          <div className="fp">{prompt.p.fingerprint}</div>
          <div className="row">
            <button className="primary" onClick={() => be.session.trustHostKey('fwd-' + prompt.id, prompt.p.fingerprint)}>Trust and connect</button>
            <button onClick={() => be.session.trustHostKey('fwd-' + prompt.id, '')}>Reject</button>
          </div>
        </div>
      )}

      <div className="section">Add forward</div>
      <div className="row">
        <Field label="Type">
          <select aria-label="Forward type" value={f.type} onChange={e => setF({...f, type: e.target.value as ForwardType})}>
            <option value="local">Local (-L)</option><option value="remote">Remote (-R)</option><option value="dynamic">Dynamic / SOCKS5 (-D)</option>
          </select>
        </Field>
        <Field label="Bind address"><input aria-label="Bind address" value={f.bind_addr} onChange={e => setF({...f, bind_addr: e.target.value})} /></Field>
        <Field label="Bind port"><input aria-label="Bind port" value={f.bind_port} onChange={e => setF({...f, bind_port: e.target.value})} placeholder="auto" /></Field>
      </div>
      {f.type !== 'dynamic' && (
        <div className="row">
          <Field label="Destination host"><input aria-label="Destination host" value={f.dest_host} onChange={e => setF({...f, dest_host: e.target.value})} /></Field>
          <Field label="Destination port"><input aria-label="Destination port" value={f.dest_port} onChange={e => setF({...f, dest_port: e.target.value})} /></Field>
        </div>
      )}
      <label><input type="checkbox" style={{width: 'auto'}} checked={f.auto_start} onChange={e => setF({...f, auto_start: e.target.checked})} /> Start automatically with the terminal</label><br />
      <label><input type="checkbox" style={{width: 'auto'}} checked={f.pub} onChange={e => setF({...f, pub: e.target.checked})} /> Allow binding to a non-loopback address</label>
      {err && <div className="error" role="alert">{err}</div>}
      <div style={{marginTop: 10}}><button className="primary" onClick={add}>Add forward</button></div>
    </Modal>
  )
}
