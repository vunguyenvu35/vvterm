import {useEffect, useRef, useState} from 'react'
import {Field, SidePanel, Section} from '../ui/Modal'
import {TERMINAL_THEMES} from '../terminal/themes'
import {Select} from '../ui/Select'
import {useBackend} from '../backend'
import {errMsg, parseTags} from '../util'
import {IconCheckCircle, IconEye, IconEyeOff, IconServer, IconXCircle} from '../ui/Icons'
import type {ConnectionTest, Group, Host, HostKeyPrompt, Identity} from '../types'

interface Props {
  host?: Host
  /** the host is a draft (for example from quick connect), not an existing record */
  isNew?: boolean
  groups: Group[]
  hosts: Host[]
  identities: Identity[]
  onClose(): void
  onSaved(h: Host): void
  /** Save, then open a terminal. */
  onConnect?(h: Host): void
  /** Lets the page show the host being typed as a draft card. */
  onDraft?(text: string): void
}

type Test = {state: 'idle'} | {state: 'running'} | {state: 'done'; result: ConnectionTest} | {state: 'failed'; message: string}

let testSeq = 0

/**
 * New / edit host, docked next to the host list. Flow: address → general → port → credentials
 * (username + password, or a key identity) → options. Test connection checks the typed values without
 * saving anything; Connect saves and opens a terminal.
 */
export function HostForm({host, isNew, groups, hosts, identities, onClose, onSaved, onConnect, onDraft}: Props) {
  const be = useBackend()
  const [f, setF] = useState({
    label: host?.label ?? '',
    hostname: host?.hostname ?? '',
    port: String(host?.port ?? 22),
    username: host?.username ?? '',
    password: '',
    identity_id: host?.identity_id ?? '',
    group_id: host?.group_id ?? '',
    jump_host_id: host?.jump_host_id ?? '',
    env: host?.env ?? '',
    tags: (host?.tags ?? []).join(', '),
    keepalive_sec: String(host?.keepalive_sec ?? 30),
    // an empty Telnet port means Telnet is off for this host
    telnet_port: host?.telnet_enabled ? String(host.telnet_port || 23) : '',
    terminal_theme: host?.terminal_theme ?? '',
  })
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<Test>({state: 'idle'})
  const [prompt, setPrompt] = useState<{key: string; p: HostKeyPrompt} | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const set = (k: keyof typeof f) => (e: {target: {value: string}}) => setF(x => ({...x, [k]: e.target.value}))
  const existing = !!host && !isNew

  useEffect(() => { onDraft?.(f.label.trim() || f.hostname.trim()) }, [f.label, f.hostname, onDraft])
  useEffect(() => () => onDraft?.(''), [onDraft])

  /** Validates the form; returns the host to save, or null after showing the problem. */
  const draft = (): Partial<Host> | null => {
    const port = Number(f.port)
    if (!f.hostname.trim()) { setErr('Hostname is required'); return null }
    if (/\s/.test(f.hostname) || /\s/.test(f.username)) { setErr('Hostname and username cannot contain spaces'); return null }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { setErr('Port must be between 1 and 65535'); return null }
    const telnet = f.telnet_port.trim() === '' ? 0 : Number(f.telnet_port)
    if (f.telnet_port.trim() !== '' && (!Number.isInteger(telnet) || telnet < 1 || telnet > 65535)) { setErr('Telnet port must be between 1 and 65535'); return null }
    setErr('')
    return {
      ...(existing ? host : {}),
      telnet_enabled: telnet > 0,
      telnet_port: telnet,
      terminal_theme: f.terminal_theme,
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
    }
  }

  /** Saves the host; a typed password becomes a vault identity first. */
  const persist = async (): Promise<Host | null> => {
    const h = draft()
    if (!h) return null
    setBusy(true)
    try {
      if (f.password && !f.identity_id) {
        const name = `${h.label || h.hostname} (password)`
        const ident = await be.vault.addPassword(name, h.username ?? '', f.password)
        h.identity_id = ident.id
      }
      return await be.hosts.saveHost(h)
    } catch (e) {
      setErr(errMsg(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const save = async () => { const h = await persist(); if (h) onSaved(h) }
  const connect = async () => {
    const h = await persist()
    if (!h) return
    onSaved(h)
    onConnect?.(h)
  }

  const runTest = async () => {
    const h = draft()
    if (!h) return
    const key = `test-${Date.now().toString(36)}-${++testSeq}`
    setTest({state: 'running'})
    const off = be.on(`term:hostkey:${key}`, (p: HostKeyPrompt) => setPrompt({key, p}))
    try {
      const result = await be.session.testConnection(h, f.identity_id ? '' : f.password, key)
      if (alive.current) setTest({state: 'done', result})
    } catch (e) {
      if (alive.current) setTest({state: 'failed', message: errMsg(e)})
    } finally {
      off()
      if (alive.current) setPrompt(null)
    }
  }

  const answer = (trust: boolean) => {
    if (!prompt) return
    void be.session.trustHostKey(prompt.key, trust ? prompt.p.fingerprint : '').catch(e => setErr(errMsg(e)))
    setPrompt(null)
  }

  return (
    <SidePanel title={existing ? `Edit ${host!.label}` : 'New host'} onClose={onClose}
      footer={
        <>
          <button onClick={runTest} disabled={test.state === 'running' || busy}>{test.state === 'running' ? 'Testing…' : 'Test connection'}</button>
          <span className="spacer" />
          <button onClick={save} disabled={busy}>Save</button>
          {onConnect && <button className="primary" onClick={connect} disabled={busy}>Connect</button>}
        </>
      }>
      <Section title="Address">
        <div className="addr-row">
          <span className="tile env-none"><IconServer size={20} /></span>
          <input aria-label="Hostname" value={f.hostname} onChange={set('hostname')} placeholder="IP or Hostname" autoFocus />
        </div>
      </Section>

      <Section title="General">
        <Field label="Label"><input aria-label="Label" value={f.label} onChange={set('label')} placeholder="Defaults to the address" /></Field>
        <Field label="Parent group">
          <Select label="Group" value={f.group_id} onChange={v => setF(x => ({...x, group_id: v}))}
            options={[{value: '', label: 'None'}, ...groups.map(g => ({value: g.id, label: g.name}))]} />
        </Field>
        <Field label="Environment (colour)">
          <Select label="Environment" value={f.env} onChange={v => setF(x => ({...x, env: v as typeof f.env}))}
            options={[{value: '', label: 'None'}, {value: 'dev', label: 'dev', hint: 'development'}, {value: 'staging', label: 'staging', hint: 'pre-production'}, {value: 'prod', label: 'prod', hint: 'production: shown in red'}]} />
        </Field>
        <Field label="Tags"><input aria-label="Tags" value={f.tags} onChange={set('tags')} placeholder="Comma separated" /></Field>
      </Section>

      <Section>
        <div className="inline-field"><span>SSH on</span><input aria-label="Port" className="port" value={f.port} onChange={set('port')} /><span>port</span></div>
        <div className="inline-field"><span>Telnet on</span><input aria-label="Telnet port" className="port" placeholder="23" value={f.telnet_port} onChange={set('telnet_port')} inputMode="numeric" /><span>port</span></div>
        {f.telnet_port.trim() !== '' && <div className="muted telnet-warning" role="note">Telnet is not encrypted: everything you type, the password included, crosses the network in clear text. Use it only on a network you trust, for devices that offer nothing else.</div>}
      </Section>

      <Section title="Credentials">
        <Field label="Username"><input aria-label="Username" value={f.username} onChange={set('username')} placeholder="Username" autoComplete="off" /></Field>
        <Field label="Password"><div className="pw-row">
          <input aria-label="Password" type={showPw ? 'text' : 'password'} value={f.password} onChange={set('password')} autoComplete="new-password"
            disabled={!!f.identity_id} placeholder={f.identity_id ? 'Using the selected identity' : existing && host?.identity_id ? 'Saved in the vault (type to replace)' : 'Password'} />
          <button type="button" className="eye" aria-label={showPw ? 'Hide password' : 'Show password'} title={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw} onClick={() => setShowPw(v => !v)}>{showPw ? <IconEyeOff size={17} /> : <IconEye size={17} />}</button>
        </div></Field>
        <Field label="Key or saved identity">
          <Select label="Identity" value={f.identity_id} onChange={v => setF(x => ({...x, identity_id: v}))}
            options={[{value: '', label: 'None', hint: 'use the password above or ssh-agent'}, ...identities.map(i => ({value: i.id, label: i.name, hint: i.auth_type === 'key' ? 'SSH key' : i.auth_type === 'password' ? 'saved password' : 'ssh-agent'}))]} />
        </Field>
        {f.password && <div className="muted">The password is stored encrypted in the vault, never in the host list.</div>}
      </Section>

      <Section title="Terminal theme">
        <Select label="Terminal theme" value={f.terminal_theme} onChange={v => setF(x => ({...x, terminal_theme: v}))}
          options={[{value: '', label: 'Use the app setting', hint: 'Settings → Terminal'}, ...TERMINAL_THEMES.map(t => ({value: t.id, label: t.name, hint: t.dark ? 'dark' : 'light'}))]} />
      </Section>

      <Section title="Options">
        <Field label="Host chaining (jump host)">
          <Select label="Jump host" value={f.jump_host_id} onChange={v => setF(x => ({...x, jump_host_id: v}))}
            options={[{value: '', label: 'Direct connection'}, ...hosts.filter(h => h.id !== host?.id).map(h => ({value: h.id, label: `Via ${h.label}`, hint: h.hostname}))]} />
        </Field>
        <div className="inline-field"><span>Keepalive</span><input aria-label="Keepalive" className="port" value={f.keepalive_sec} onChange={set('keepalive_sec')} /><span>seconds</span></div>
      </Section>

      {prompt && (
        <div className="notice" role="alertdialog" aria-label="Host key confirmation">
          <b>Unknown host key for {prompt.p.host}</b>
          <div className="fp" data-testid="fingerprint">{prompt.p.fingerprint}</div>
          <div className="row">
            <button className="primary" onClick={() => answer(true)}>Trust and continue</button>
            <button onClick={() => answer(false)}>Cancel</button>
          </div>
        </div>
      )}

      {test.state === 'done' && (
        <div className={'test-result ' + (test.result.ok ? 'ok' : 'bad')} role="status" data-testid="test-result">
          <b className="result-title">{test.result.ok ? <IconCheckCircle size={16} /> : <IconXCircle size={16} />} {test.result.ok ? 'Connection successful' : 'Connection failed'}</b>
          <div>{test.result.message}</div>
          {test.result.ok && <div className="muted">{test.result.server_version} · {test.result.latency_ms} ms{test.result.hops > 1 ? ` · ${test.result.hops} hops` : ''}</div>}
        </div>
      )}
      {test.state === 'failed' && <div className="test-result bad" role="status"><b className="result-title"><IconXCircle size={16} /> Cannot test</b><div>{test.message}</div></div>}
      {err && <div className="error" role="alert">{err}</div>}
    </SidePanel>
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
    <SidePanel title={group ? 'Edit group' : 'New group'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <Section title="General">
        <input aria-label="Group name" value={name} onChange={e => setName(e.target.value)} placeholder="Group name" autoFocus />
        <Field label="Parent group">
          <Select label="Parent group" value={parent} onChange={setParent}
            options={[{value: '', label: 'Top level'}, ...groups.filter(g => g.id !== group?.id).map(g => ({value: g.id, label: g.name}))]} />
        </Field>
        <div className="inline-field"><span>Colour</span><input aria-label="Color" type="color" className="color" value={color || '#3a82f7'} onChange={e => setColor(e.target.value)} /></div>
      </Section>
      {err && <div className="error" role="alert">{err}</div>}
    </SidePanel>
  )
}
