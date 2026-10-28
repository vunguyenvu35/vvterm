/** The hosts opened most recently (newest first), for the "Recent connections" of a new tab. Kept in this browser profile. */
const KEY = 'vvterm.recent'
const MAX = 12

export function getRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : []
  } catch {
    return []
  }
}

export function recordRecent(hostId: string) {
  if (!hostId || hostId === 'local' || hostId.includes(':')) return
  try { localStorage.setItem(KEY, JSON.stringify([hostId, ...getRecent().filter(x => x !== hostId)].slice(0, MAX))) } catch { /* not remembered */ }
}
