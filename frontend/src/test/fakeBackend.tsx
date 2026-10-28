import {ReactNode} from 'react'
import {BackendContext, Backend} from '../lib/backend'
import {ToastProvider} from '../lib/ui/Toast'
import {DEFAULT_SETTINGS} from '../lib/settings/defaults'
import type {ActivityEntry, KnownHost, RemoteEntry, TransferResult, ConnectionTest, ForwardStatus, Group, Host, Identity, PortForward, Settings, Snippet, VaultStatus} from '../lib/types'

export interface Fake extends Backend {
  state: {
    vault: VaultStatus
    password: string
    groups: Group[]
    hosts: Host[]
    identities: Identity[]
    forwards: PortForward[]
    snippets: Snippet[]
    running: Record<string, string>
    settings: Settings
    /** remote file system for SFTP: path -> entry ("/" is the root) */
    remote: Record<string, {dir: boolean; size: number}>
    /** this computer's files for the Local pane: path -> entry */
    local: Record<string, {dir: boolean; size: number}>
    /** true: openSettings succeeds like the real app (a native window opens); false: it rejects (browser mode) */
    nativeSettings: boolean
    /** serial devices the Serial panel finds */
    serialPorts: string[]
    /** the system clipboard */
    clipboard: string
    knownHosts: KnownHost[]
    /** the activity log, newest first */
    logs: ActivityEntry[]
    testResult: ConnectionTest
    calls: Array<[string, ...unknown[]]>
  }
  emit(event: string, data?: unknown): void
}

let n = 0

type Tree = Record<string, {dir: boolean; size: number}>
/** Copies files and folders between two in-memory trees, skipping files that exist unless overwrite. */
function copyTree(from: Tree, to: Tree, sources: string[], destDir: string, overwrite: boolean, done: (name: string) => void): TransferResult {
  const res: TransferResult = {files: 0, dirs: 0, bytes: 0, skipped: [], ignored: []}
  const join = (d: string, name: string) => (d === '/' ? '' : d) + '/' + name
  for (const src of sources) {
    if (!from[src]) throw 'no such file or folder: ' + src
    const name = src.slice(src.lastIndexOf('/') + 1)
    const inside = Object.keys(from).filter(p => p === src || p.startsWith(src + '/')).sort()
    for (const p of inside) {
      const rel = name + p.slice(src.length)
      const dst = join(destDir, rel)
      if (from[p].dir) {
        if (!to[dst]) to[dst] = {dir: true, size: 0}
        res.dirs++
      } else if (to[dst] && !overwrite) {
        res.skipped.push(rel)
      } else {
        to[dst] = {dir: false, size: from[p].size}
        res.files++
        res.bytes += from[p].size
      }
    }
    done(name)
  }
  return res
}
const id = (p: string) => `${p}${++n}`

/** In-memory Backend that behaves like the Go side closely enough for UI tests. */
export function makeFake(init: Partial<Fake['state']> = {}): Fake {
  const listeners = new Map<string, Set<(d: any) => void>>()
  const state: Fake['state'] = {
    vault: {exists: true, unlocked: false, keychain_enabled: false, auto_lock_minutes: 15},
    password: 'correct horse battery',
    groups: [], hosts: [], identities: [], forwards: [], snippets: [], running: {},
    settings: {...DEFAULT_SETTINGS, font_family: 'monospace'},
    remote: {'/': {dir: true, size: 0}, '/projects': {dir: true, size: 0}, '/readme.txt': {dir: false, size: 1536}, '/projects/app.log': {dir: false, size: 20480}},
    local: {
      '/': {dir: true, size: 0}, '/Users': {dir: true, size: 0}, '/Users/me': {dir: true, size: 0}, '/Users/me/Documents': {dir: true, size: 0},
      '/Users/me/notes.txt': {dir: false, size: 300}, '/Users/me/.zshrc': {dir: false, size: 120}, '/Users/me/Documents/cv.pdf': {dir: false, size: 40960},
    },
    nativeSettings: false,
    serialPorts: ['/dev/cu.usbserial-1410', '/dev/cu.usbmodem1101'],
    clipboard: '',
    knownHosts: [],
    logs: [],
    testResult: {ok: true, message: 'Connected to 10.0.0.1 as root', server_version: 'SSH-2.0-OpenSSH_9.6', latency_ms: 42, hops: 1},
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
      create: async (pw, hint) => { rec('vault.create', pw, ...(hint ? [hint] : [])); state.vault = {...state.vault, exists: true, unlocked: true, hint: hint || undefined} },
      setHint: async h => { rec('vault.setHint', h); state.vault = {...state.vault, hint: h.trim() || undefined} },
      unlock: async pw => {
        rec('vault.unlock', pw)
        if (pw !== state.password) throw 'wrong master password'
        state.vault = {...state.vault, unlocked: true}
      },
      unlockBiometric: async () => { rec('vault.unlockBiometric'); state.vault = {...state.vault, unlocked: true} },
      lock: async () => { state.vault = {...state.vault, unlocked: false}; emit('vault:locked') },
      resetVault: async c => {
        rec('vault.resetVault', c)
        if (c.trim() !== 'RESET') throw 'type RESET to confirm'
        state.vault = {...state.vault, exists: false, unlocked: false, keychain_enabled: false}
        state.identities = state.identities.filter(i => i.auth_type === 'agent')
      },
      changePassword: async (o, nw) => { rec('vault.changePassword', o, nw); if (o !== state.password) throw 'wrong master password'; state.password = nw },
      setAutoLock: async m => { rec('vault.setAutoLock', m); state.vault = {...state.vault, auto_lock_minutes: m} },
      enableBiometric: async () => { state.vault = {...state.vault, keychain_enabled: true} },
      disableBiometric: async () => { state.vault = {...state.vault, keychain_enabled: false} },
      listIdentities: async () => [...state.identities],
      addKey: async (name, path, pass) => { rec('vault.addKey', name, path, pass); return upsert(state.identities, {name, auth_type: 'key', public_key: 'ssh-ed25519 AAAAimported'}, 'i') },
      addKeyPair: async (name, pem, pass, pub, cert) => { rec('vault.addKeyPair', name, pem, pass, pub, cert); return upsert(state.identities, {name, auth_type: 'key', public_key: pub.trim() || 'ssh-ed25519 AAAApasted', certificate: cert.trim() || undefined}, 'i') },
      addKeyPEM: async (name, pem, pass) => { rec('vault.addKeyPEM', name, pem, pass); return upsert(state.identities, {name, auth_type: 'key', public_key: 'ssh-ed25519 AAAApasted'}, 'i') },
      addPassword: async (name, user, pw) => { rec('vault.addPassword', name, user, pw); return upsert(state.identities, {name, username: user, auth_type: 'password'}, 'i') },
      addAgent: async (name, user) => { rec('vault.addAgent', name, user); return upsert(state.identities, {name, username: user, auth_type: 'agent'}, 'i') },
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
        return upsert(state.hosts, {port: 22, keepalive_sec: 30, ...h, label: h.label || h.hostname}, 'h')
      },
      deleteHost: async i => { state.hosts = state.hosts.filter(h => h.id !== i) },
      setTelnetPassword: async (i, pw) => { rec('hosts.setTelnetPassword', i, pw) },
    },
    session: {
      open: async (h, c, r) => { rec('session.open', h, c, r); return id('s') },
      attach: async s => { rec('session.attach', s) },
      write: async (s, d) => { rec('session.write', s, d) },
      resize: async () => {},
      reconnect: async s => { rec('session.reconnect', s) },
      close: async s => { rec('session.close', s) },
      trustHostKey: async (s, f) => { rec('session.trustHostKey', s, f) },
      testConnection: async (h, p, k) => { rec('session.testConnection', h, p, k); return state.testResult },
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
    sftp: {
      open: async (h, k) => { rec('sftp.open', h, k); return {sid: id('sf'), home: '/', host: state.hosts.find(x => x.id === h)?.label ?? 'host'} },
      list: async (s, dir) => {
        rec('sftp.list', s, dir)
        if (!state.remote[dir]?.dir) throw 'no such directory: ' + dir
        const out: RemoteEntry[] = []
        for (const [p, e] of Object.entries(state.remote)) {
          const parent = p.slice(0, p.lastIndexOf('/')) || '/'
          if (p !== '/' && parent === dir) out.push({name: p.slice(p.lastIndexOf('/') + 1), path: p, size: e.size, mode: e.dir ? 'drwxr-xr-x' : '-rw-r--r--', mod_time: '2026-10-28T10:00:00Z', is_dir: e.dir, is_link: false})
        }
        return out.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
      },
      chmod: async (s, p, m) => { rec('sftp.chmod', s, p, m) },
      mkdir: async (s, p) => { rec('sftp.mkdir', s, p); if (state.remote[p]) throw 'file exists'; state.remote[p] = {dir: true, size: 0} },
      rename: async (s, a, b) => {
        rec('sftp.rename', s, a, b)
        if (state.remote[b]) throw b + ': already exists'
        for (const p of Object.keys(state.remote)) if (p === a || p.startsWith(a + '/')) { state.remote[b + p.slice(a.length)] = state.remote[p]; delete state.remote[p] }
      },
      remove: async (s, p, rec_) => {
        rec('sftp.remove', s, p, rec_)
        const kids = Object.keys(state.remote).filter(x => x.startsWith(p + '/'))
        if (kids.length && !rec_) throw 'directory not empty'
        for (const k of kids) delete state.remote[k]
        delete state.remote[p]
      },
      upload: async (s, local, dir, overwrite) => {
        rec('sftp.upload', s, local, dir, overwrite)
        if (!state.local[local] || state.local[local].dir) throw 'no such file: ' + local
        const dest = (dir === '/' ? '' : dir) + '/' + local.slice(local.lastIndexOf('/') + 1)
        if (state.remote[dest] && !overwrite) throw dest + ': already exists'
        state.remote[dest] = {dir: false, size: 2048}
        emit('sftp:progress:' + s, {name: dest.slice(dest.lastIndexOf('/') + 1), direction: 'upload', done: 2048, total: 2048})
        return dest
      },
      download: async (s, remotePath, local, overwrite) => {
        rec('sftp.download', s, remotePath, local, overwrite)
        if (state.local[local] && !overwrite) throw local + ': already exists'
        state.local[local] = {dir: false, size: 10}
        emit('sftp:progress:' + s, {name: remotePath.slice(remotePath.lastIndexOf('/') + 1), direction: 'download', done: 10, total: 10})
      },
      close: async s => { rec('sftp.close', s) },
      uploadAll: async (s, locals, dir, overwrite) => {
        rec('sftp.uploadAll', s, locals, dir, overwrite)
        return copyTree(state.local, state.remote, locals, dir, overwrite, e => emit('sftp:progress:' + s, {name: e, direction: 'upload', done: 1, total: 1}))
      },
      downloadAll: async (s, remotes, dir, overwrite) => {
        rec('sftp.downloadAll', s, remotes, dir, overwrite)
        return copyTree(state.remote, state.local, remotes, dir, overwrite, e => emit('sftp:progress:' + s, {name: e, direction: 'download', done: 1, total: 1}))
      },
    },
    serial: {
      ports: async () => [...state.serialPorts],
    },
    knownHosts: {
      list: async () => [...state.knownHosts],
      forget: async (h, f) => {
        rec('knownHosts.forget', h, f)
        const n = state.knownHosts.length
        state.knownHosts = state.knownHosts.filter(k => !(k.host === h && k.fingerprint === f))
        if (state.knownHosts.length === n) throw 'that host is not in known_hosts'
      },
    },
    logs: {
      list: async f => {
        rec('logs.list', f)
        const q = f.query.trim().toLowerCase()
        return state.logs
          .filter(e => !f.kinds.length || f.kinds.includes(e.kind))
          .filter(e => !q || (e.message + ' ' + (e.host_label ?? '')).toLowerCase().includes(q))
          .slice(0, f.limit || 500)
      },
      clear: async () => { rec('logs.clear'); state.logs = [] },
    },
    local: {
      home: async () => '/Users/me',
      list: async dir => {
        rec('local.list', dir)
        if (!state.local[dir]?.dir) throw 'no such directory: ' + dir
        const out: RemoteEntry[] = []
        for (const [p, e] of Object.entries(state.local)) {
          const parent = p.slice(0, p.lastIndexOf('/')) || '/'
          if (p !== '/' && parent === dir) out.push({name: p.slice(p.lastIndexOf('/') + 1), path: p, size: e.size, mode: e.dir ? 'drwxr-xr-x' : '-rw-r--r--', mod_time: '2026-10-28T10:00:00Z', is_dir: e.dir, is_link: false})
        }
        return out.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
      },
      chmod: async (p, m) => { rec('local.chmod', p, m) },
      tempDir: async () => '/tmp/vvterm-open-1',
      mkdir: async p => { rec('local.mkdir', p); if (state.local[p]) throw 'file exists'; state.local[p] = {dir: true, size: 0} },
      rename: async (a, b) => {
        rec('local.rename', a, b)
        if (state.local[b]) throw b + ' already exists'
        for (const p of Object.keys(state.local)) if (p === a || p.startsWith(a + '/')) { state.local[b + p.slice(a.length)] = state.local[p]; delete state.local[p] }
      },
      remove: async (p, r) => {
        rec('local.remove', p, r)
        const kids = Object.keys(state.local).filter(x => x.startsWith(p + '/'))
        if (kids.length && !r) throw 'directory not empty'
        for (const k of kids) delete state.local[k]
        delete state.local[p]
      },
    },
    snippets: {
      list: async () => [...state.snippets],
      save: async s => {
        rec('snippets.save', s)
        if (!s.label?.trim() || !s.script?.trim()) throw 'snippet label and script are required'
        return upsert(state.snippets, s, 'sn')
      },
      remove: async i => { state.snippets = state.snippets.filter(x => x.id !== i) },
    },
    system: {
      pickFile: async () => '/tmp/picked',
      pickDirectory: async () => '/tmp/dir',
      saveFile: async (_t, name) => '/tmp/' + name,
      openUrl: async u => { rec('system.openUrl', u) },
      info: async () => ({version: '1.1.0-test'}),
      toggleMaximise: async () => { rec('system.toggleMaximise') },
      readClipboard: async () => { rec('system.readClipboard'); return state.clipboard },
      writeClipboard: async t => { rec('system.writeClipboard', t); state.clipboard = t },
      openWindow: async (h, t) => { rec('system.openWindow', h, t) },
      openPath: async p => { rec('system.openPath', p) },
      openPathWith: async (p, a) => { rec('system.openPathWith', p, a) },
      openSettings: async () => {
        rec('system.openSettings')
        if (!state.nativeSettings) throw new Error('native windows are not available')
      },
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
