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

