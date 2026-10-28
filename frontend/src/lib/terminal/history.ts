/**
 * Commands typed in the terminals, newest first, for the History tab of the terminal sidebar. They stay in
 * this browser profile only (localStorage). Only lines that were echoed back by the terminal are kept, so
 * what is typed at a password prompt (which the shell does not echo) never ends up here.
 */
const KEY = 'vvterm.history'
export const MAX_HISTORY = 300
const MAX_LINE = 2000

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

let items = load()
const subs = new Set<() => void>()
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(items)) } catch { /* private window: keep it in memory */ }
  subs.forEach(f => f())
}

export const getHistory = () => items

export function subscribeHistory(f: () => void): () => void {
  subs.add(f)
  return () => { subs.delete(f) }
}

/** Adds a command at the top; the same command typed again moves up instead of repeating. */
export function recordCommand(line: string) {
  const l = line.trim()
  if (!l || l.length > MAX_LINE) return
  items = [l, ...items.filter(x => x !== l)].slice(0, MAX_HISTORY)
  save()
}

export function clearHistory() {
  items = []
  save()
}

/**
 * Follows what is typed and reports each line that was finished with Enter. Backspace edits the line,
 * Ctrl-C / Ctrl-U drop it, and escape sequences (arrows, function keys) are skipped.
 */
export function createLineTracker(): (data: string) => string[] {
  let buf = ''
  let esc = false
  return data => {
    const done: string[] = []
    for (const ch of data) {
      if (esc) {
        // a CSI/SS3 sequence ends with a letter or "~"
        if (/[A-Za-z~]/.test(ch) && ch !== 'O' && ch !== '[') esc = false
        continue
      }
      if (ch === '\x1b') esc = true
      else if (ch === '\r' || ch === '\n') { if (buf.trim()) done.push(buf); buf = '' }
      else if (ch === '\x7f' || ch === '\b') buf = buf.slice(0, -1)
      else if (ch === '\x03' || ch === '\x15') buf = ''
      else if (ch >= ' ') buf += ch
    }
    return done
  }
}
