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
  /** also reachable with Telnet (unencrypted) on this port */
  telnet_enabled?: boolean
  telnet_port?: number
  telnet_username?: string
  /** '' or 'utf-8' (default), or 'iso-8859-1' */
  telnet_encoding?: string
  /** this host's own terminal colour theme (an id from the catalogue); empty follows Settings */
  terminal_theme?: string
  /** the AI assistant switch of this host: '' (off on prod hosts, ask elsewhere), off, ask or on */
  ai_policy?: AiPolicy
}

export interface Identity {
  id: string
  name: string
  username?: string
  auth_type: AuthType
  public_key?: string
  /** an OpenSSH user certificate for the key (public, not a secret) */
  certificate?: string
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
  /** the reminder of the master password the user wrote, shown on the unlock screen */
  hint?: string
  /** this Mac can ask for Touch ID */
  biometric_available?: boolean
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
  /** copy the selection to the clipboard as soon as it is made */
  copy_on_select: boolean
  /** what a right click in a terminal does */
  right_click: 'paste' | 'menu' | 'none'
  scrollback: number
  auto_lock_minutes: number
  sync_url: string
  zoom: number // interface scale in percent
  confirm_tab_close: boolean
  /** a host opens on a Choose protocol screen first */
  ask_protocol: boolean
  /** the lock screen asks for Touch ID / Windows Hello by itself, without a click */
  biometric_on_open: boolean
  /** colour URLs, IP addresses, paths and error / warning / success words in terminal output */
  highlight: boolean
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
  folder: string
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
  /** when it was last changed (RFC 3339) */
  updated_at?: string
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

/** A machine whose host key was trusted (a line of known_hosts). */
export interface KnownHost {
  host: string
  key_type: string
  fingerprint: string
}

/** One line of the activity log. */
export interface ActivityEntry {
  id: number
  at: string
  kind: 'connect' | 'disconnect' | 'hostkey' | 'forward' | 'sftp' | 'transfer' | 'vault' | 'sync'
  host_id?: string
  host_label?: string
  message: string
  ok: boolean
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

// ---- AI assistant ----

export type AiPolicy = '' | 'off' | 'ask' | 'on'
export type AiState = 'ready' | 'needs_signin' | 'unsupported' | 'not_installed' | ''
export type AiRisk = 'low' | 'medium' | 'high'

export interface AiStatus {state: AiState; version: string; detail: string; hint: string}

export interface AiProvider {
  id: string
  name: string
  status: AiStatus
  enabled: boolean
  default: boolean
  /** the default model of the provider; '' lets the CLI decide */
  model: string
  supports_mcp: boolean
  /** takes pictures (sent as they are, after the user confirms) */
  supports_images: boolean
  custom: boolean
}

export interface AiModel {id: string; name: string; description?: string}
export interface AiModelList {models: AiModel[]; error: string; can_list: boolean}

export interface AiSettings {
  lines: number
  patterns: string[]
  auto_run: boolean
  default_provider: string
}

export interface AiSessionState {
  host_id: string
  label: string
  /** the effective policy */
  policy: 'off' | 'ask' | 'on'
  /** what is saved on the host ('' = default) */
  stored: AiPolicy
  production: boolean
  confirmed: boolean
  connected: boolean
}

export interface AiFinding {kind: string; count: number}

export interface AiPreview {
  text: string
  findings: AiFinding[]
  redacted: number
  lines: number
  alt_screen: boolean
  vault_locked: boolean
  empty: boolean
  /** pictures that would be sent as they are: nothing can be hidden in a picture */
  images: number
}

export interface AiCommand {
  cmd: string
  why: string
  risk: AiRisk
  reasons: string[]
  warnings: string[]
  blocked: boolean
  block_reason: string
  /** it only reads: it is run as soon as the answer shows, without asking */
  auto?: boolean
}

export interface AiReply {text: string; commands: AiCommand[]; provider: string; model: string; redacted: number}

export interface AiCommandCheck {
  blocked: boolean
  block_reason: string
  risk: AiRisk
  reasons: string[]
  warnings: string[]
  run_allowed: boolean
  run_reason: string
  typed_confirm: boolean
}

export interface AiAttachment {name: string; mime: string; /** the content of a text file */ text?: string; /** the base64 content of an image */ data?: string}
export interface AiAskOptions {provider: string; model: string; lines: number; selection: string; request_id?: string; attachments?: AiAttachment[]; /** the user agreed to send pictures as they are */ allow_images?: boolean}
export interface AiCustomProvider {id?: string; name: string; command: string; args?: string[]; prompt_via?: 'stdin' | 'arg'}

export type McpMode = 'allow' | 'ask' | 'off'

export interface McpServer {
  id: string
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string[]
  url: string
  /** names only: the values are in the vault and are never read back */
  env: string[]
  headers: string[]
  enabled: boolean
  trusted: boolean
  host_ids: string[]
  providers: string[]
  status: string
  reviewed: number
}

export interface McpServerInput {
  id?: string
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  /** a non-empty value is saved to the vault; an empty one keeps what is stored */
  env?: Record<string, string>
  headers?: Record<string, string>
  remove_env?: string[]
  remove_headers?: string[]
  enabled: boolean
  trusted: boolean
  host_ids?: string[]
  providers?: string[]
}

export interface McpTool {name: string; description: string; read_only: boolean; mode: McpMode; new: boolean}
export interface McpImportItem {ref: string; source: string; name: string; type: 'stdio' | 'http'; command: string; args: string[]; url: string; env: string[]; headers: string[]}

/** One step of an answer: a tool the assistant used. */
export interface AiStep {server: string; tool: string; state: string; note: string}
