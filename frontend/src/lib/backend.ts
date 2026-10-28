import {createContext, useContext} from 'react'
import type {
  ConnectionTest, ExportReport, ForwardStatus, Group, Host, HostFilter, Identity, ImportReport, PortForward, Settings,
  ActivityEntry, KnownHost, RemoteEntry, SftpInfo, Snippet, SyncStatus, TransferResult, VaultStatus,
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
    resetVault(confirm: string): Promise<void>
    changePassword(oldPW: string, newPW: string): Promise<void>
    setAutoLock(minutes: number): Promise<void>
    enableBiometric(): Promise<void>
    disableBiometric(): Promise<void>
    listIdentities(): Promise<Identity[]>
    addKey(name: string, path: string, passphrase: string): Promise<Identity>
    addKeyPair(name: string, pem: string, passphrase: string, publicKey: string, certificate: string): Promise<Identity>
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
    /** keeps the Telnet password of a host in the vault (empty forgets it) */
    setTelnetPassword(hostId: string, password: string): Promise<void>
  }
  session: {
    open(hostId: string, cols: number, rows: number): Promise<string>
    attach(sid: string): Promise<void>
    write(sid: string, data: string): Promise<void>
    resize(sid: string, cols: number, rows: number): Promise<void>
    reconnect(sid: string, cols: number, rows: number): Promise<void>
    close(sid: string): Promise<void>
    trustHostKey(sid: string, fingerprint: string): Promise<void>
    testConnection(host: Partial<Host>, password: string, promptKey: string): Promise<ConnectionTest>
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
  sftp: {
    open(hostId: string, promptKey: string): Promise<SftpInfo>
    list(sid: string, dir: string): Promise<RemoteEntry[]>
    mkdir(sid: string, path: string): Promise<void>
    rename(sid: string, from: string, to: string): Promise<void>
    chmod(sid: string, path: string, mode: number): Promise<void>
    remove(sid: string, path: string, recursive: boolean): Promise<void>
    upload(sid: string, local: string, remoteDir: string, overwrite: boolean): Promise<string>
    download(sid: string, remote: string, local: string, overwrite: boolean): Promise<void>
    close(sid: string): Promise<void>
    /** Files and folders (everything inside) into a remote folder. Existing files are skipped unless overwrite. */
    uploadAll(sid: string, locals: string[], remoteDir: string, overwrite: boolean): Promise<TransferResult>
    /** Remote files and folders into a local folder. Existing files are skipped unless overwrite. */
    downloadAll(sid: string, remotes: string[], localDir: string, overwrite: boolean): Promise<TransferResult>
  }
  serial: {
    ports(): Promise<string[]>
  }
  knownHosts: {
    list(): Promise<KnownHost[]>
    /** Forget a host's key: the next connection asks to trust it again. */
    forget(host: string, fingerprint: string): Promise<void>
  }
  logs: {
    list(f: {kinds: string[]; query: string; limit: number}): Promise<ActivityEntry[]>
    clear(): Promise<void>
  }
  /** This computer's files (the Local pane of the SFTP screen). */
  local: {
    home(): Promise<string>
    list(dir: string): Promise<RemoteEntry[]>
    mkdir(path: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    remove(path: string, recursive: boolean): Promise<void>
    chmod(path: string, mode: number): Promise<void>
    /** a new private folder for files that are only looked at */
    tempDir(): Promise<string>
  }
  snippets: {
    list(): Promise<Snippet[]>
    save(s: Partial<Snippet>): Promise<Snippet>
    remove(id: string): Promise<void>
  }
  system: {
    pickFile(title: string): Promise<string>
    pickDirectory(title: string): Promise<string>
    saveFile(title: string, name: string): Promise<string>
    openUrl(url: string): Promise<void>
    info(): Promise<{version: string}>
    /** Opens the Settings window (a second native window). Rejects where none exists: the UI then shows its in-app window. */
    openSettings(): Promise<void>
    /** Opens a new native window with a new session to the same place (host id, "local", "serial:..."). Rejects where there is none. */
    openWindow(hostId: string, title: string): Promise<void>
    /** Opens a file with the app the system has for it (never a file that runs programs). */
    openPath(path: string): Promise<void>
    /** Opens a file with the chosen application. */
    openPathWith(path: string, app: string): Promise<void>
    /** Zoom the native window (the green button / a double click on the title bar). A no-op in a browser. */
    toggleMaximise(): Promise<void>
    /** The system clipboard: through the native runtime (a webview often refuses to read it), else the browser. */
    readClipboard(): Promise<string>
    writeClipboard(text: string): Promise<void>
  }
  /** Subscribe to a backend event; returns an unsubscribe function. */
  on(event: string, cb: (data: any) => void): () => void
}

type Bound = Record<string, (...a: any[]) => Promise<any>>

declare global {
  interface Window {
    go?: Record<string, Record<string, Bound>>
    runtime?: {EventsOn(name: string, cb: (...d: any[]) => void): () => void; WindowToggleMaximise?(): void; Quit?(): void}
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
      resetVault: c => u('VaultService', 'ResetVault', c),
      changePassword: (o, n) => u('VaultService', 'ChangePassword', o, n),
      setAutoLock: m => u('VaultService', 'SetAutoLock', m),
      enableBiometric: () => u('VaultService', 'EnableBiometric'),
      disableBiometric: () => u('VaultService', 'DisableBiometric'),
      listIdentities: () => u('VaultService', 'ListIdentities'),
      addKey: (n, p, pp) => u('VaultService', 'AddKey', n, p, pp),
      addKeyPEM: (n, p, pp) => u('VaultService', 'AddKeyPEM', n, p, pp),
      addKeyPair: (n, p, pp, pub, cert) => u('VaultService', 'AddKeyPair', n, p, pp, pub, cert),
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
      setTelnetPassword: (id, pw) => u('HostService', 'SetTelnetPassword', id, pw),
    },
    session: {
      open: (h, c, r) => u('SessionService', 'Open', h, c, r),
      attach: s => u('SessionService', 'Attach', s),
      write: (s, d) => u('SessionService', 'Write', s, d),
      resize: (s, c, r) => u('SessionService', 'Resize', s, c, r),
      reconnect: (s, c, r) => u('SessionService', 'Reconnect', s, c, r),
      close: s => u('SessionService', 'Close', s),
      trustHostKey: (s, f) => u('SessionService', 'TrustHostKey', s, f),
      testConnection: (h, p, k) => u('SessionService', 'TestConnection', h, p, k),
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
    sftp: {
      open: (h, k) => u('SftpService', 'Open', h, k),
      list: async (s, d) => (await u<RemoteEntry[]>('SftpService', 'List', s, d)) ?? [],
      mkdir: (s, p) => u('SftpService', 'Mkdir', s, p),
      rename: (s, a, b) => u('SftpService', 'Rename', s, a, b),
      chmod: (s, p, m) => u('SftpService', 'Chmod', s, p, m),
      remove: (s, p, r) => u('SftpService', 'Delete', s, p, r),
      upload: (s, l, d, o) => u('SftpService', 'Upload', s, l, d, o),
      download: (s, r, l, o) => u('SftpService', 'Download', s, r, l, o),
      close: s => u('SftpService', 'Close', s),
      uploadAll: (s, l, d, o) => u('SftpService', 'UploadAll', s, l, d, o),
      downloadAll: (s, r, d, o) => u('SftpService', 'DownloadAll', s, r, d, o),
    },
    knownHosts: {
      list: async () => (await call<KnownHost[]>('usecase', 'KnownHostsService', 'List')) ?? [],
      forget: (h, f) => call('usecase', 'KnownHostsService', 'Forget', h, f),
    },
    logs: {
      list: async f => (await call<ActivityEntry[]>('usecase', 'LogService', 'List', f)) ?? [],
      clear: () => call('usecase', 'LogService', 'Clear'),
    },
    serial: {
      ports: async () => (await call<string[]>('usecase', 'SerialService', 'Ports')) ?? [],
    },
    local: {
      home: () => call('usecase', 'LocalService', 'Home'),
      list: async d => (await call<RemoteEntry[]>('usecase', 'LocalService', 'List', d)) ?? [],
      mkdir: p => call('usecase', 'LocalService', 'Mkdir', p),
      rename: (a, b) => call('usecase', 'LocalService', 'Rename', a, b),
      remove: (p, r) => call('usecase', 'LocalService', 'Delete', p, r),
      chmod: (p, m) => call('usecase', 'LocalService', 'Chmod', p, m),
      tempDir: () => call('usecase', 'LocalService', 'TempDir'),
    },
    snippets: {
      list: async () => (await u<Snippet[]>('SnippetService', 'List')) ?? [],
      save: s => u('SnippetService', 'Save', s),
      remove: id => u('SnippetService', 'Delete', id),
    },
    system: {
      pickFile: t => call('app', 'SystemService', 'PickFile', t),
      pickDirectory: t => call('app', 'SystemService', 'PickDirectory', t),
      saveFile: (t, n) => call('app', 'SystemService', 'SaveFile', t, n),
      openUrl: async url => {
        try {
          await call('app', 'SystemService', 'OpenURL', url)
        } catch {
          window.open(url, '_blank', 'noopener') // browser mode (e2e)
        }
      },
      info: () => call('app', 'SystemService', 'Info'),
      openSettings: () => call('app', 'SystemService', 'OpenSettings'),
      openWindow: (h, t) => call('app', 'SystemService', 'OpenWindow', h, t),
      openPath: p => call('app', 'SystemService', 'OpenPath', p),
      openPathWith: (p, a) => call('app', 'SystemService', 'OpenPathWith', p, a),
      toggleMaximise: async () => { window.runtime?.WindowToggleMaximise?.() },
      readClipboard: async () => {
        try { return String((await call('app', 'SystemService', 'ClipboardText')) ?? '') } catch { return navigator.clipboard.readText() }
      },
      writeClipboard: async text => {
        try { await call('app', 'SystemService', 'SetClipboardText', text) } catch { await navigator.clipboard.writeText(text) }
      },
    },
    on: (event, cb) => {
      const rt = window.runtime
      if (!rt) return () => {}
      return rt.EventsOn(event, (...d: any[]) => cb(d[0]))
    },
  }
}

/** True in the Settings window process, which has no use cases of its own (only the bridge). */
export const inSettingsWindow = () => !!window.go?.app?.SettingsBridge

/**
 * Backend of the Settings window: settings, vault security options and sync are forwarded to the main
 * window's process through the Go bridge; help links and the version are local.
 */
export function bridgeBackend(): Backend {
  const base = wailsBackend()
  const rpc = async <T,>(service: string, method: string, ...args: unknown[]): Promise<T> => {
    const text: string = await window.go!.app.SettingsBridge.Call(service, method, JSON.stringify(args))
    return (text ? JSON.parse(text) : undefined) as T
  }
  const unavailable = () => Promise.reject(new Error('not available in the settings window'))
  return {
    ...base,
    vault: {
      ...base.vault,
      status: () => rpc('VaultService', 'Status'),
      changePassword: (o, n) => rpc('VaultService', 'ChangePassword', o, n),
      setAutoLock: m => rpc('VaultService', 'SetAutoLock', m),
      enableBiometric: () => rpc('VaultService', 'EnableBiometric'),
      disableBiometric: () => rpc('VaultService', 'DisableBiometric'),
      resetVault: c => rpc('VaultService', 'ResetVault', c),
    },
    settings: {
      get: () => rpc('SettingsService', 'Get'),
      save: s => rpc('SettingsService', 'Save', s),
    },
    sync: {
      configure: url => rpc('SyncService', 'Configure', url),
      syncNow: () => rpc('SyncService', 'SyncNow'),
      join: pw => rpc('SyncService', 'JoinExisting', pw),
      status: () => rpc('SyncService', 'Status'),
    },
    system: {...base.system, openSettings: unavailable, openWindow: unavailable},
  }
}

/** True in a terminal window process (Duplicate in new window): it has the TerminalWindow object bound. */
export const inTerminalWindow = () => !!window.go?.app?.TerminalWindow

/** What a terminal window was opened for, as the Go side was told. */
export async function windowTarget(): Promise<{host_id: string; title: string}> {
  return window.go!.app.TerminalWindow.Target() as unknown as {host_id: string; title: string}
}

/**
 * An app window (Duplicate in new window) is the whole app in another process: it holds no use cases of its own.
 * Every call the app makes on window.go.usecase.<Service>.<Method> is sent to the main window's process through
 * the Go bridge, and what the main process emits (sessions' output, hosts changed...) comes back as local events.
 * Only the native parts (dialogs, clipboard) stay with this process.
 */
export function installWindowBridge() {
  const call = (service: string, method: string) => async (...args: unknown[]) => {
    const text: string = await window.go!.app.TerminalWindow.Call(service, method, JSON.stringify(args))
    return text ? JSON.parse(text) : undefined
  }
  const usecase = new Proxy({}, {get: (_t, service: string) => new Proxy({}, {get: (_u, method: string) => call(service, method)})})
  window.go!.usecase = usecase as never
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
