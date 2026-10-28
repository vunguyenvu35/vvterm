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

export interface Settings {
  theme: 'dark' | 'light'
  font_size: number
  font_family: string
  auto_lock_minutes: number
  sync_url: string
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
