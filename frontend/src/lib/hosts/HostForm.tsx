import {useState} from 'react'
import {Field, Modal} from '../ui/Modal'
import {useBackend} from '../backend'
import {errMsg, parseTags} from '../util'
import type {Group, Host, Identity} from '../types'

interface Props {
  host?: Host
  groups: Group[]
  hosts: Host[]
  identities: Identity[]
  onClose(): void
  onSaved(h: Host): void
}

/** Create/edit a host. Client-side checks mirror the backend rules; the backend remains the authority. */
export function HostForm({host, groups, hosts, identities, onClose, onSaved}: Props) {
  const be = useBackend()
  const [f, setF] = useState({
    label: host?.label ?? '',
    hostname: host?.hostname ?? '',
    port: String(host?.port ?? 22),
    username: host?.username ?? '',
    identity_id: host?.identity_id ?? '',
    group_id: host?.group_id ?? '',
    jump_host_id: host?.jump_host_id ?? '',
    env: host?.env ?? '',
    tags: (host?.tags ?? []).join(', '),
    keepalive_sec: String(host?.keepalive_sec ?? 30),
  })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof f) => (e: {target: {value: string}}) => setF({...f, [k]: e.target.value})

  const save = async () => {
    setErr('')
    const port = Number(f.port)
    if (!f.hostname.trim()) return setErr('Hostname is required')
    if (/\s/.test(f.hostname) || /\s/.test(f.username)) return setErr('Hostname and username cannot contain spaces')
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setErr('Port must be between 1 and 65535')
    try {
      const saved = await be.hosts.saveHost({
        ...(host ?? {}),
        label: f.label.trim(),
        hostname: f.hostname.trim(),
        port,
        username: f.username.trim(),
        identity_id: f.identity_id,
        group_id: f.group_id,
        jump_host_id: f.jump_host_id,
        env: f.env as Host['env'],
        tags: parseTags(f.tags),
        keepalive_sec: Number(f.keepalive_sec) || 30,
      })
      onSaved(saved)
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  return (
    <Modal title={host ? `Edit ${host.label}` : 'New host'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <Field label="Label"><input aria-label="Label" value={f.label} onChange={set('label')} placeholder="web-1 (defaults to hostname)" /></Field>
      <div className="row">
        <Field label="Hostname"><input aria-label="Hostname" value={f.hostname} onChange={set('hostname')} placeholder="10.0.0.5 or host.example.com" /></Field>
        <div className="fixed" style={{width: 90}}><Field label="Port"><input aria-label="Port" value={f.port} onChange={set('port')} /></Field></div>
      </div>
      <div className="row">
        <Field label="Username"><input aria-label="Username" value={f.username} onChange={set('username')} /></Field>
        <Field label="Identity">
          <select aria-label="Identity" value={f.identity_id} onChange={set('identity_id')}>
            <option value="">ssh-agent / none</option>
            {identities.map(i => <option key={i.id} value={i.id}>{i.name} ({i.auth_type})</option>)}
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="Group">
          <select aria-label="Group" value={f.group_id} onChange={set('group_id')}>
            <option value="">No group</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label="Environment">
          <select aria-label="Environment" value={f.env} onChange={set('env')}>
            <option value="">None</option><option value="dev">dev</option><option value="staging">staging</option><option value="prod">prod</option>
          </select>
        </Field>
      </div>
      <Field label="Jump host">
        <select aria-label="Jump host" value={f.jump_host_id} onChange={set('jump_host_id')}>
          <option value="">Direct connection</option>
          {hosts.filter(h => h.id !== host?.id).map(h => <option key={h.id} value={h.id}>{h.label}</option>)}
        </select>
      </Field>
      <div className="row">
        <Field label="Tags (comma separated)"><input aria-label="Tags" value={f.tags} onChange={set('tags')} /></Field>
        <div className="fixed" style={{width: 130}}><Field label="Keepalive (s)"><input aria-label="Keepalive" value={f.keepalive_sec} onChange={set('keepalive_sec')} /></Field></div>
      </div>
      {err && <div className="error" role="alert">{err}</div>}
    </Modal>
  )
}

export function GroupForm({group, groups, onClose, onSaved}: {group?: Group; groups: Group[]; onClose(): void; onSaved(): void}) {
  const be = useBackend()
  const [name, setName] = useState(group?.name ?? '')
  const [parent, setParent] = useState(group?.parent_id ?? '')
  const [color, setColor] = useState(group?.color ?? '')
  const [err, setErr] = useState('')
  const save = async () => {
    if (!name.trim()) return setErr('Name is required')
    try {
      await be.hosts.saveGroup({...(group ?? {}), name: name.trim(), parent_id: parent, color})
      onSaved()
    } catch (e) {
      setErr(errMsg(e))
    }
  }
  return (
    <Modal title={group ? 'Edit group' : 'New group'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <Field label="Name"><input aria-label="Group name" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
      <Field label="Parent group">
        <select aria-label="Parent group" value={parent} onChange={e => setParent(e.target.value)}>
          <option value="">Top level</option>
          {groups.filter(g => g.id !== group?.id).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </Field>
      <Field label="Color"><input aria-label="Color" type="color" value={color || '#5b8cff'} onChange={e => setColor(e.target.value)} /></Field>
      {err && <div className="error" role="alert">{err}</div>}
    </Modal>
  )
}
