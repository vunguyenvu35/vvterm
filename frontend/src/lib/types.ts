export type Env = '' | 'dev' | 'staging' | 'prod'
export type AuthType = 'key' | 'password' | 'agent'
export type ForwardType = 'local' | 'remote' | 'dynamic'

export interface Group {
  id: string
  name: string
  parent_id?: string
  color?: string
  sort_order: number
}

export interface Host {
  id: string
  label: string
  group_id?: string
  hostname: string
  port: number
  username: string
  identity_id?: string
  jump_host_id?: string
  env?: Env
  tags?: string[]
  keepalive_sec: number
  /** server type learned on the first connection (ubuntu, debian, freebsd…); '' until then */
  os?: string
}

export interface Identity {
  id: string
  name: string
  username?: string
  auth_type: AuthType
  public_key?: string
}

export interface PortForward {
  id: string
  label?: string
  host_id: string
  type: ForwardType
  bind_addr: string
  bind_port: number
  dest_host?: string
  dest_port?: number
  auto_start: boolean
  allow_public_bind?: boolean
}

export interface ForwardStatus {
  forward: PortForward
  state: 'stopped' | 'running' | 'error'
  addr?: string
  error?: string
}

export interface VaultStatus {
  exists: boolean
  unlocked: boolean
  keychain_enabled: boolean
  auto_lock_minutes: number
}

export type ThemeMode = 'auto' | 'light' | 'dark'
export type CursorStyle = 'block' | 'bar' | 'underline'

export interface Settings {
  theme: ThemeMode
  terminal_theme: string // 'auto' follows the app theme, otherwise a catalogue id
  font_size: number
  font_family: string
  cursor_style: CursorStyle
  cursor_blink: boolean
  scrollback: number
  auto_lock_minutes: number
  sync_url: string
  zoom: number // interface scale in percent
  confirm_close: boolean
  reduce_motion: boolean
  account_name: string
  account_email: string
  shortcuts: Record<string, string> // overrides only: action id -> combo
}

export interface ConnectionTest {
  ok: boolean
  message: string
  server_version?: string
  latency_ms: number
  hops: number
}

export interface SyncStatus {
  configured: boolean
  repo_url: string
  last_sync: string
  last_error?: string
  syncing: boolean
}

export interface HostFilter {
  query: string
  group_id: string
  env: Env
  tag: string
}

export interface ImportReport {
  hosts_added: number
  groups_added: number
  forwards_added: number
  keys_imported: number
  skipped: string[]
  warnings: string[]
}

export interface ExportReport {
  files: string[]
  key_files: string[]
  warnings: string[]
}

export interface HostKeyPrompt {
  host: string
  fingerprint: string
  key_type: string
}

export interface ClosedInfo {
  reason: string
  clean: boolean
}

export interface Snippet {
  id: string
  label: string
  description?: string
  script: string
}

export interface RemoteEntry {
  name: string
  path: string
  size: number
  mode: string
  mod_time: string
  is_dir: boolean
  is_link: boolean
}

export interface SftpInfo {
  sid: string
  home: string
  host: string
}

/** What a multi-file transfer did (see usecase.TransferResult). */
export interface TransferResult {
  files: number
  dirs: number
  bytes: number
  /** files that already exist and were not replaced */
  skipped: string[]
  /** links and special files, never followed */
  ignored: string[]
}

export interface TransferProgress {
  name: string
  direction: 'upload' | 'download'
  done: number
  total: number
}
