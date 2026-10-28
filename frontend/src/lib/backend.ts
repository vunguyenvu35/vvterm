import {createContext, useContext} from 'react'
import type {
  ExportReport, ForwardStatus, Group, Host, HostFilter, Identity, ImportReport, PortForward, Settings,
  SyncStatus, VaultStatus,
} from './types'

/**
 * Everything the UI needs from the Go backend. The real implementation talks to the
 * Wails bindings; tests provide a fake. No method ever returns a secret.
 */
export interface Backend {
  vault: {
    status(): Promise<VaultStatus>
    create(pw: string): Promise<void>
    unlock(pw: string): Promise<void>
    unlockBiometric(): Promise<void>
    lock(): Promise<void>
    changePassword(oldPW: string, newPW: string): Promise<void>
    setAutoLock(minutes: number): Promise<void>
    enableBiometric(): Promise<void>
    disableBiometric(): Promise<void>
    listIdentities(): Promise<Identity[]>
    addKey(name: string, path: string, passphrase: string): Promise<Identity>
    addKeyPEM(name: string, pem: string, passphrase: string): Promise<Identity>
    addPassword(name: string, user: string, pw: string): Promise<Identity>
    addAgent(name: string, user: string): Promise<Identity>
    generateKey(name: string): Promise<Identity>
    deleteIdentity(id: string): Promise<void>
  }
  hosts: {
    listGroups(): Promise<Group[]>
    saveGroup(g: Partial<Group>): Promise<Group>
    deleteGroup(id: string): Promise<void>
    listHosts(f: Partial<HostFilter>): Promise<Host[]>
    saveHost(h: Partial<Host>): Promise<Host>
    deleteHost(id: string): Promise<void>
  }
  session: {
    open(hostId: string, cols: number, rows: number): Promise<string>
    attach(sid: string): Promise<void>
    write(sid: string, data: string): Promise<void>
    resize(sid: string, cols: number, rows: number): Promise<void>
    reconnect(sid: string, cols: number, rows: number): Promise<void>
    close(sid: string): Promise<void>
    trustHostKey(sid: string, fingerprint: string): Promise<void>
  }
  forwards: {
    list(): Promise<ForwardStatus[]>
    save(f: Partial<PortForward>): Promise<PortForward>
    remove(id: string): Promise<void>
    start(id: string): Promise<void>
    stop(id: string): Promise<void>
  }
  sync: {
    configure(url: string): Promise<void>
    syncNow(): Promise<void>
    join(masterPassword: string): Promise<void>
    status(): Promise<SyncStatus>
  }
  data: {
    importSSHConfig(path: string, conflict: string): Promise<ImportReport>
    exportSSHConfig(dir: string, withKeys: boolean): Promise<ExportReport>
    exportPlainJSON(path: string): Promise<void>
    exportBackup(path: string, pw: string): Promise<void>
    importBackup(path: string, pw: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    save(s: Settings): Promise<Settings>
  }
  system: {
    pickFile(title: string): Promise<string>
    pickDirectory(title: string): Promise<string>
    saveFile(title: string, name: string): Promise<string>
  }
  /** Subscribe to a backend event; returns an unsubscribe function. */
  on(event: string, cb: (data: any) => void): () => void
}

type Bound = Record<string, (...a: any[]) => Promise<any>>

declare global {
  interface Window {
    go?: Record<string, Record<string, Bound>>
    runtime?: {EventsOn(name: string, cb: (...d: any[]) => void): () => void}
  }
}

function svc(pkg: string, name: string): Bound {
  const s = window.go?.[pkg]?.[name]
  if (!s) throw new Error(`backend service ${pkg}.${name} is not available`)
  return s
}

/** Backend backed by the Wails-generated bindings on window.go. */
export function wailsBackend(): Backend {
  const U = (n: string) => svc('usecase', n)
  const call = <T,>(pkg: string, n: string, m: string, ...a: any[]) => svc(pkg, n)[m](...a) as Promise<T>
  const u = <T,>(n: string, m: string, ...a: any[]) => call<T>('usecase', n, m, ...a)
  void U
  return {
    vault: {
      status: () => u('VaultService', 'Status'),
      create: pw => u('VaultService', 'Create', pw),
      unlock: pw => u('VaultService', 'Unlock', pw),
      unlockBiometric: () => u('VaultService', 'UnlockBiometric'),
      lock: () => u('VaultService', 'Lock'),
      changePassword: (o, n) => u('VaultService', 'ChangePassword', o, n),
      setAutoLock: m => u('VaultService', 'SetAutoLock', m),
      enableBiometric: () => u('VaultService', 'EnableBiometric'),
      disableBiometric: () => u('VaultService', 'DisableBiometric'),
      listIdentities: () => u('VaultService', 'ListIdentities'),
      addKey: (n, p, pp) => u('VaultService', 'AddKey', n, p, pp),
      addKeyPEM: (n, p, pp) => u('VaultService', 'AddKeyPEM', n, p, pp),
      addPassword: (n, user, pw) => u('VaultService', 'AddPassword', n, user, pw),
      addAgent: (n, user) => u('VaultService', 'AddAgent', n, user),
      generateKey: n => u('VaultService', 'GenerateKey', n, 'ed25519'),
      deleteIdentity: id => u('VaultService', 'DeleteIdentity', id),
    },
    hosts: {
      listGroups: () => u('HostService', 'ListGroups'),
      saveGroup: g => u('HostService', 'SaveGroup', g),
      deleteGroup: id => u('HostService', 'DeleteGroup', id),
      listHosts: f => u('HostService', 'ListHosts', {query: '', group_id: '', env: '', tag: '', ...f}),
      saveHost: h => u('HostService', 'SaveHost', h),
      deleteHost: id => u('HostService', 'DeleteHost', id),
    },
    session: {
      open: (h, c, r) => u('SessionService', 'Open', h, c, r),
      attach: s => u('SessionService', 'Attach', s),
      write: (s, d) => u('SessionService', 'Write', s, d),
      resize: (s, c, r) => u('SessionService', 'Resize', s, c, r),
      reconnect: (s, c, r) => u('SessionService', 'Reconnect', s, c, r),
      close: s => u('SessionService', 'Close', s),
      trustHostKey: (s, f) => u('SessionService', 'TrustHostKey', s, f),
    },
    forwards: {
      list: () => u('ForwardService', 'List'),
      save: f => u('ForwardService', 'SaveForward', f),
      remove: id => u('ForwardService', 'DeleteForward', id),
      start: id => u('ForwardService', 'Start', id),
      stop: id => u('ForwardService', 'Stop', id),
    },
    sync: {
      configure: url => u('SyncService', 'Configure', url),
      syncNow: () => u('SyncService', 'SyncNow'),
      join: pw => u('SyncService', 'JoinExisting', pw),
      status: () => u('SyncService', 'Status'),
    },
    data: {
      importSSHConfig: async (p, c) => normalizeImport(await u<ImportReport>('ImportExportService', 'ImportSSHConfig', p, c)),
      exportSSHConfig: async (d, k) => normalizeExport(await u<ExportReport>('ImportExportService', 'ExportSSHConfig', d, k)),
      exportPlainJSON: p => u('ImportExportService', 'ExportPlainJSON', p),
      exportBackup: (p, pw) => u('ImportExportService', 'ExportBackup', p, pw),
      importBackup: (p, pw) => u('ImportExportService', 'ImportBackup', p, pw),
    },
    settings: {
      get: () => u('SettingsService', 'Get'),
      save: s => u('SettingsService', 'Save', s),
    },
    system: {
      pickFile: t => call('app', 'SystemService', 'PickFile', t),
      pickDirectory: t => call('app', 'SystemService', 'PickDirectory', t),
      saveFile: (t, n) => call('app', 'SystemService', 'SaveFile', t, n),
    },
    on: (event, cb) => {
      const rt = window.runtime
      if (!rt) return () => {}
      return rt.EventsOn(event, (...d: any[]) => cb(d[0]))
    },
  }
}

/** Go marshals nil slices as null; the UI relies on arrays, so normalise at the boundary. */
export function normalizeImport(r: ImportReport): ImportReport {
  return {...r, skipped: r?.skipped ?? [], warnings: r?.warnings ?? []}
}

export function normalizeExport(r: ExportReport): ExportReport {
  return {...r, files: r?.files ?? [], key_files: r?.key_files ?? [], warnings: r?.warnings ?? []}
}

export const BackendContext = createContext<Backend | null>(null)

export function useBackend(): Backend {
  const b = useContext(BackendContext)
  if (!b) throw new Error('BackendContext is missing')
  return b
}
