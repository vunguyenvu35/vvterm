/**
 * Keyboard shortcuts. A combination is text such as "Mod+Shift+K": modifiers (Mod = Cmd on macOS and Ctrl
 * elsewhere; Ctrl, Alt, Shift, Meta) joined by "+", ending in one key. The user's overrides live in
 * Settings.shortcuts (action id -> combo); anything not overridden uses the default below. The backend
 * validates the same grammar, so a combo that passes here is accepted there.
 */
export interface ActionDef {
  id: string
  label: string
  group: 'General' | 'Pages' | 'Tabs' | 'Terminal' | 'View'
  default: string
  /** the default on a Mac, when it differs (Cmd+C copies there; Ctrl+C is the interrupt key everywhere else) */
  defaultMac?: string
}

export const ACTIONS: ActionDef[] = [
  {id: 'open_settings', label: 'Open settings', group: 'General', default: 'Mod+,'},
  {id: 'new_connection', label: 'New connection (find a host)', group: 'General', default: 'Mod+T'},
  {id: 'new_host', label: 'New host', group: 'General', default: 'Mod+N'},
  {id: 'new_local_terminal', label: 'New terminal on this computer', group: 'General', default: 'Mod+Shift+T'},
  {id: 'go_hosts', label: 'Go to Hosts', group: 'Pages', default: 'Mod+1'},
  {id: 'go_keychain', label: 'Go to Keychain', group: 'Pages', default: 'Mod+2'},
  {id: 'go_forwards', label: 'Go to Port Forwarding', group: 'Pages', default: 'Mod+3'},
  {id: 'go_snippets', label: 'Go to Snippets', group: 'Pages', default: 'Mod+4'},
  {id: 'go_knownhosts', label: 'Go to Known Hosts', group: 'Pages', default: 'Mod+5'},
  {id: 'go_logs', label: 'Go to Logs', group: 'Pages', default: 'Mod+6'},
  {id: 'go_vaults', label: 'Back to Vaults (the home screen)', group: 'Pages', default: 'Mod+Shift+H'},
  {id: 'open_sftp', label: 'Open SFTP', group: 'Pages', default: 'Mod+Shift+S'},
  {id: 'lock_vault', label: 'Lock the vault', group: 'General', default: 'Mod+L'},
  {id: 'close_tab', label: 'Close the current tab', group: 'Tabs', default: 'Mod+W'},
  {id: 'next_tab', label: 'Next tab', group: 'Tabs', default: 'Ctrl+Tab'},
  {id: 'prev_tab', label: 'Previous tab', group: 'Tabs', default: 'Ctrl+Shift+Tab'},
  {id: 'close_pane', label: 'Close the focused pane', group: 'Terminal', default: 'Mod+Shift+W'},
  {id: 'broadcast_input', label: 'Broadcast input to every pane of the tab', group: 'Terminal', default: 'Mod+Alt+B', defaultMac: 'Mod+B'},
  {id: 'ai_next_model', label: 'Switch the assistant to its next model', group: 'Terminal', default: 'Mod+Shift+M'},
  {id: 'split_right', label: 'Split the pane right', group: 'Terminal', default: 'Mod+D'},
  {id: 'split_down', label: 'Split the pane down', group: 'Terminal', default: 'Mod+Shift+D'},
  {id: 'terminal_copy', label: 'Copy the selection', group: 'Terminal', default: 'Mod+Shift+C', defaultMac: 'Mod+C'},
  {id: 'terminal_paste', label: 'Paste into the terminal', group: 'Terminal', default: 'Mod+Shift+V', defaultMac: 'Mod+V'},
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

/** The default combination of an action on this platform. */
export const defaultOf = (a: ActionDef, mac = isMac()): string => (mac && a.defaultMac) || a.default

/** The combination in effect for every action: the override when there is one, else the default. */
export function effective(overrides: Record<string, string> | undefined, mac = isMac()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of ACTIONS) out[a.id] = overrides?.[a.id] || defaultOf(a, mac)
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
const normStep = (c: string, mac = isMac()) => c.split('+').map(p => (p === 'Mod' ? (mac ? 'meta' : 'ctrl') : p.toLowerCase())).sort().join('+')
const norm = (c: string, mac = isMac()) => stepsOf(c).map(x => normStep(x, mac)).join(' ')

/** A shortcut is one step ("Mod+K") or two ("Mod+K M": press ⌘K, let go, press M). */
export const stepsOf = (combo: string): string[] => combo.split(' ')
export const isChord = (combo: string) => combo.includes(' ')

/** Does the event produce this single step? A two-step shortcut never matches a single event: see stepMatches. */
export function matches(e: KeyboardEvent, combo: string, mac = isMac()): boolean {
  if (isChord(combo)) return false
  return stepMatches(e, combo, mac)
}

/** Does the event produce this one step (the first or the second of a two-step shortcut, or a single shortcut)? */
export function stepMatches(e: KeyboardEvent, step: string, mac = isMac()): boolean {
  const got = comboFromEvent(e, mac)
  return !!got && normStep(got, mac) === normStep(step, mac)
}

/** Do two steps name the same key? */
export const sameStep = (a: string, b: string, mac = isMac()) => normStep(a, mac) === normStep(b, mac)

function validateStep(c: string, needsModifier: boolean): string | null {
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
  if (needsModifier && !(mods.has('Mod') || mods.has('Ctrl') || mods.has('Alt') || mods.has('Meta'))) return 'add Ctrl, Alt or ⌘ so normal typing never triggers it'
  return null
}

/** The same rules the backend enforces, so the editor can explain a rejection before saving. */
export function validateCombo(c: string): string | null {
  const steps = stepsOf(c)
  if (steps.length > 2) return 'a shortcut can have at most two steps'
  return validateStep(steps[0], true) ?? (steps[1] !== undefined ? validateStep(steps[1], false) : null)
}

/** The action already using this shortcut, ignoring `exceptId`. A single shortcut that is the first step of a two-step one counts too. */
export function conflictFor(combo: string, exceptId: string, map: Record<string, string>): ActionDef | null {
  for (const a of ACTIONS) {
    const other = map[a.id]
    if (a.id === exceptId || !other) continue
    if (norm(other) === norm(combo)) return a
    const mine = stepsOf(combo), theirs = stepsOf(other)
    if (mine.length !== theirs.length && sameStep(mine[0], theirs[0])) return a
  }
  return null
}

const KEY_TEXT: Record<string, string> = {Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', Delete: '⌦', Enter: '↵', Tab: 'Tab'}

/** The keys of one step, one by one: ["⇧", "⌘", "T"] on macOS, ["Ctrl", "Shift", "T"] elsewhere (for drawing key caps). */
export function stepKeys(step: string, mac = isMac()): string[] {
  const parts = step.split('+')
  const key = KEY_TEXT[parts[parts.length - 1]] ?? parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (mac) {
    const sym: Record<string, string> = {Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘'}
    return [...['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta'].filter(m => mods.includes(m)).map(m => sym[m]), key]
  }
  const word: Record<string, string> = {Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win'}
  return [...['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'].filter(m => mods.includes(m)).map(m => word[m]), key]
}

/** Human-readable form: ⌘⇧K on macOS, Ctrl+Shift+K elsewhere; a two-step shortcut shows both steps ("⌘K M"). */
export function formatCombo(combo: string, mac = isMac()): string {
  return stepsOf(combo).map(step => {
    const k = stepKeys(step, mac)
    return mac ? k.join('') : k.join('+')
  }).join(' ')
}

/** Set while the editor is recording a new shortcut, so the global handler stays quiet. */
export const capture = {active: false}
