import type {Settings} from '../types'

/** Used until the saved settings arrive, and by tests. Mirrors the backend defaults. */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark', terminal_theme: 'auto', font_size: 13, font_family: "Menlo, Monaco, 'Courier New', monospace",
  cursor_style: 'block', cursor_blink: true, scrollback: 10000, auto_lock_minutes: 15, sync_url: '',
  zoom: 100, confirm_tab_close: false, ask_protocol: false, biometric_on_open: true, highlight: true, copy_on_select: true, right_click: 'paste', reduce_motion: false, auto_update_check: true, account_name: '', account_email: '', shortcuts: {},
}
