import {ReactNode} from 'react'
import {BackendContext, Backend} from '../lib/backend'
import {ToastProvider} from '../lib/ui/Toast'
import type {ForwardStatus, Group, Host, Identity, PortForward, Settings, VaultStatus} from '../lib/types'

export interface Fake extends Backend {
  state: {
    vault: VaultStatus
    password: string
    groups: Group[]
    hosts: Host[]
    identities: Identity[]
    forwards: PortForward[]
    running: Record<string, string>
    settings: Settings
    calls: Array<[string, ...unknown[]]>
  }
  emit(event: string, data?: unknown): void
}

let n = 0
const id = (p: string) => `${p}${++n}`

/** In-memory Backend that behaves like the Go side closely enough for UI tests. */
export function makeFake(init: Partial<Fake['state']> = {}): Fake {
  const listeners = new Map<string, Set<(d: any) => void>>()
  const state: Fake['state'] = {
    vault: {exists: true, unlocked: false, keychain_enabled: false, auto_lock_minutes: 15},
    password: 'correct horse battery',
    groups: [], hosts: [], identities: [], forwards: [], running: {},
    settings: {theme: 'dark', font_size: 13, font_family: 'monospace', auto_lock_minutes: 15, sync_url: ''},
    calls: [],
    ...init,
  }
  const rec = (name: string, ...a: unknown[]) => { state.calls.push([name, ...a]) }
  const emit = (e: string, d?: unknown) => listeners.get(e)?.forEach(cb => cb(d))
  const upsert = <T extends {id: string}>(list: T[], item: Partial<T>, prefix: string): T => {
    const full = {...item, id: item.id || id(prefix)} as T
    const i = list.findIndex(x => x.id === full.id)
    if (i >= 0) list[i] = full
    else list.push(full)
    return full
  }
  const fake: Fake = {
    state,
    emit,
    vault: {
      status: async () => ({...state.vault}),
      create: async pw => { rec('vault.create', pw); state.vault = {...state.vault, exists: true, unlocked: true} },
      unlock: async pw => {
        rec('vault.unlock', pw)
        if (pw !== state.password) throw 'wrong master password'
        state.vault = {...state.vault, unlocked: true}
      },
      unlockBiometric: async () => { rec('vault.unlockBiometric'); state.vault = {...state.vault, unlocked: true} },
      lock: async () => { state.vault = {...state.vault, unlocked: false}; emit('vault:locked') },
      changePassword: async (o, nw) => { rec('vault.changePassword', o, nw); if (o !== state.password) throw 'wrong master password'; state.password = nw },
      setAutoLock: async m => { rec('vault.setAutoLock', m); state.vault = {...state.vault, auto_lock_minutes: m} },
      enableBiometric: async () => { state.vault = {...state.vault, keychain_enabled: true} },
      disableBiometric: async () => { state.vault = {...state.vault, keychain_enabled: false} },
      listIdentities: async () => [...state.identities],
      addKey: async (name, path, pass) => { rec('vault.addKey', name, path, pass); return upsert(state.identities, {name, auth_type: 'key', public_key: 'ssh-ed25519 AAAAimported'}, 'i') },
      addKeyPEM: async (name, pem, pass) => { rec('vault.addKeyPEM', name, pem, pass); return upsert(state.identities, {name, auth_type: 'key', public_key: 'ssh-ed25519 AAAApasted'}, 'i') },
      addPassword: async (name, user, pw) => { rec('vault.addPassword', name, user, pw); return upsert(state.identities, {name, username: user, auth_type: 'password'}, 'i') },
      addAgent: async (name, user) => upsert(state.identities, {name, username: user, auth_type: 'agent'}, 'i'),
      generateKey: async name => upsert(state.identities, {name, auth_type: 'key', public_key: 'ssh-ed25519 AAAAgenerated vvterm'}, 'i'),
      deleteIdentity: async i => {
        if (state.hosts.some(h => h.identity_id === i)) throw 'identity is used by a host'
        state.identities = state.identities.filter(x => x.id !== i)
      },
    },
    hosts: {
      listGroups: async () => [...state.groups],
      saveGroup: async g => upsert(state.groups, {sort_order: 0, ...g}, 'g'),
      deleteGroup: async i => { state.groups = state.groups.filter(g => g.id !== i) },
      listHosts: async () => [...state.hosts],
      saveHost: async h => {
        rec('hosts.saveHost', h)
        if (!h.hostname) throw 'hostname is required'
        return upsert(state.hosts, {port: 22, keepalive_sec: 30, label: h.hostname, ...h}, 'h')
      },
      deleteHost: async i => { state.hosts = state.hosts.filter(h => h.id !== i) },
    },
    session: {
      open: async (h, c, r) => { rec('session.open', h, c, r); return id('s') },
      attach: async s => { rec('session.attach', s) },
      write: async (s, d) => { rec('session.write', s, d) },
      resize: async () => {},
      reconnect: async s => { rec('session.reconnect', s) },
      close: async s => { rec('session.close', s) },
      trustHostKey: async (s, f) => { rec('session.trustHostKey', s, f) },
    },
    forwards: {
      list: async (): Promise<ForwardStatus[]> => state.forwards.map(f => ({
        forward: f, state: state.running[f.id] ? 'running' : 'stopped', addr: state.running[f.id],
      })),
      save: async f => upsert(state.forwards, {bind_addr: '127.0.0.1', auto_start: false, ...f}, 'f'),
      remove: async i => { state.forwards = state.forwards.filter(f => f.id !== i) },
      start: async i => { rec('forwards.start', i); state.running[i] = '127.0.0.1:5555'; emit('forward:state', {id: i}) },
      stop: async i => { delete state.running[i]; emit('forward:state', {id: i}) },
    },
    sync: {
      configure: async u => { rec('sync.configure', u) },
      syncNow: async () => { rec('sync.syncNow') },
      join: async pw => { rec('sync.join', pw) },
      status: async () => ({configured: true, repo_url: 'git@example.com:me/sync.git', last_sync: '0001-01-01T00:00:00Z', syncing: false}),
    },
    data: {
      importSSHConfig: async (p, c) => { rec('data.import', p, c); return {hosts_added: 2, groups_added: 1, forwards_added: 0, keys_imported: 1, skipped: ['dup'], warnings: ['ProxyCommand ignored']} },
      exportSSHConfig: async (d, k) => { rec('data.exportSSH', d, k); return {files: ['a'], key_files: k ? ['k'] : [], warnings: []} },
      exportPlainJSON: async p => { rec('data.exportJSON', p) },
      exportBackup: async (p, pw) => { rec('data.exportBackup', p, pw) },
      importBackup: async (p, pw) => { rec('data.importBackup', p, pw) },
    },
    settings: {
      get: async () => ({...state.settings}),
      save: async s => { state.settings = {...state.settings, ...s}; return state.settings },
    },
    system: {
      pickFile: async () => '/tmp/picked',
      pickDirectory: async () => '/tmp/dir',
      saveFile: async (_t, name) => '/tmp/' + name,
    },
    on: (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb)
      return () => listeners.get(event)!.delete(cb)
    },
  }
  return fake
}

export function Providers({be, children}: {be: Backend; children: ReactNode}) {
  return (
    <BackendContext.Provider value={be}>
      <ToastProvider>{children}</ToastProvider>
    </BackendContext.Provider>
  )
}

export const host = (o: Partial<Host> = {}): Host => ({id: id('h'), label: 'web-1', hostname: '10.0.0.1', port: 22, username: 'root', keepalive_sec: 30, ...o})
