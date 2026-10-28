/**
 * Keyboard shortcuts. A combination is text such as "Mod+Shift+K": modifiers (Mod = Cmd on macOS and Ctrl
 * elsewhere; Ctrl, Alt, Shift, Meta) joined by "+", ending in one key. The user's overrides live in
 * Settings.shortcuts (action id -> combo); anything not overridden uses the default below. The backend
 * validates the same grammar, so a combo that passes here is accepted there.
 */
export interface ActionDef {
  id: string
  label: string
  group: 'General' | 'Tabs' | 'Terminal' | 'View'
  default: string
}

export const ACTIONS: ActionDef[] = [
  {id: 'open_settings', label: 'Open settings', group: 'General', default: 'Mod+,'},
  {id: 'new_connection', label: 'New connection (find a host)', group: 'General', default: 'Mod+T'},
  {id: 'lock_vault', label: 'Lock the vault', group: 'General', default: 'Mod+L'},
  {id: 'close_tab', label: 'Close the current tab', group: 'Tabs', default: 'Mod+W'},
  {id: 'next_tab', label: 'Next tab', group: 'Tabs', default: 'Ctrl+Tab'},
  {id: 'prev_tab', label: 'Previous tab', group: 'Tabs', default: 'Ctrl+Shift+Tab'},
  {id: 'close_pane', label: 'Close the focused pane', group: 'Terminal', default: 'Mod+Shift+W'},
  {id: 'split_right', label: 'Split the pane right', group: 'Terminal', default: 'Mod+D'},
  {id: 'split_down', label: 'Split the pane down', group: 'Terminal', default: 'Mod+Shift+D'},
  {id: 'terminal_search', label: 'Search the terminal scrollback', group: 'Terminal', default: 'Mod+F'},
  {id: 'zoom_in', label: 'Zoom in', group: 'View', default: 'Mod+='},
  {id: 'zoom_out', label: 'Zoom out', group: 'View', default: 'Mod+-'},
  {id: 'zoom_reset', label: 'Reset zoom', group: 'View', default: 'Mod+0'},
]

/** Keys that cannot be rebound: they always do the same thing. */
export const FIXED_SHORTCUTS: {label: string; keys: string}[] = [
  {label: 'Close a panel, menu or window', keys: 'Esc'},
  {label: 'Reconnect a dropped session', keys: 'Enter'},
  {label: 'Connect to a host', keys: 'Double-click, or Enter in the search box'},
]

export const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '')

/** The combination in effect for every action: the override when there is one, else the default. */
export function effective(overrides: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of ACTIONS) out[a.id] = overrides?.[a.id] || a.default
  return out
}

const NAMED: Record<string, string> = {
  ' ': 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
}
const CODE_PUNCT: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Minus: '-', Equal: '=', Backquote: '`',
}

/** The key part of an event as it appears in a combo, or null for a bare modifier / unsupported key. */
export function keyOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  const {key, code} = e
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(key)) return null
  if (NAMED[key]) return NAMED[key]
  if (/^F([1-9]|1[0-2])$/.test(key)) return key
  if (key.length === 1) {
    if (code?.startsWith('Key')) return code.slice(3)
    if (code?.startsWith('Digit')) return code.slice(5)
    if (code && CODE_PUNCT[code]) return CODE_PUNCT[code]
    const k = key.length === 1 ? key.toUpperCase() : key
    return /^[A-Z0-9,./;'[\]\\\-=`]$/.test(k) ? k : null
  }
  return null
}

/** Builds the combo text for a keydown event (null while only modifiers are held). */
export function comboFromEvent(e: KeyboardEvent, mac = isMac()): string | null {
  const k = keyOf(e)
  if (!k) return null
  const mods: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod')
  if (mac && e.ctrlKey) mods.push('Ctrl')
  if (!mac && e.metaKey) mods.push('Meta')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return [...mods, k].join('+')
}

// Mod is Cmd on a Mac and Ctrl elsewhere, so "Ctrl+Tab" and "Mod+Tab" are the same key on Windows/Linux.
const norm = (c: string, mac = isMac()) => c.split('+').map(p => (p === 'Mod' ? (mac ? 'meta' : 'ctrl') : p.toLowerCase())).sort().join('+')

/** Does the event produce this combo? */
export function matches(e: KeyboardEvent, combo: string, mac = isMac()): boolean {
  const got = comboFromEvent(e, mac)
  return !!got && norm(got, mac) === norm(combo, mac)
}

/** The same rules the backend enforces, so the editor can explain a rejection before saving. */
export function validateCombo(c: string): string | null {
  const parts = c.split('+')
  const key = parts[parts.length - 1]
  const mods = new Set<string>()
  for (const m of parts.slice(0, -1)) {
    if (!['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'].includes(m) || mods.has(m)) return `invalid modifier "${m}"`
    mods.add(m)
  }
  if (key === 'Escape') return 'Escape is reserved: it always closes panels'
  if (/^F([1-9]|1[0-2])$/.test(key)) return null
  if (!(NAMED[key === 'Space' ? ' ' : key] || /^[A-Za-z0-9,./;'[\]\\\-=`]$/.test(key))) return `unsupported key "${key}"`
  if (!(mods.has('Mod') || mods.has('Ctrl') || mods.has('Alt') || mods.has('Meta'))) return 'add Ctrl, Alt or ⌘ so normal typing never triggers it'
  return null
}

/** The action already using this combo, ignoring `exceptId`. */
export function conflictFor(combo: string, exceptId: string, map: Record<string, string>): ActionDef | null {
  for (const a of ACTIONS) {
    if (a.id !== exceptId && map[a.id] && norm(map[a.id]) === norm(combo)) return a
  }
  return null
}

/** Human-readable form: ⌘⇧K on macOS, Ctrl+Shift+K elsewhere. */
export function formatCombo(combo: string, mac = isMac()): string {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  const keyText = ({Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', Delete: '⌦', Enter: '↵', Tab: 'Tab'} as Record<string, string>)[key] ?? key
  const mods = parts.slice(0, -1)
  if (mac) {
    const sym: Record<string, string> = {Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘'}
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta']
    return order.filter(m => mods.includes(m)).map(m => sym[m]).join('') + keyText
  }
  const word: Record<string, string> = {Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win'}
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta']
  return [...order.filter(m => mods.includes(m)).map(m => word[m]), keyText].join('+')
}

/** Set while the editor is recording a new shortcut, so the global handler stays quiet. */
export const capture = {active: false}
