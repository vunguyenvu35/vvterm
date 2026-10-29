/**
 * Registry of live terminal panes. Anything that needs to type into a terminal (snippets)
 * asks the registry instead of reaching into the pane component. A writer returns false when
 * the pane cannot take input yet (still connecting, or disconnected).
 */
type Writer = (text: string) => boolean

const panes = new Map<string, Writer>()

export function registerPane(id: string, w: Writer): () => void {
  panes.set(id, w)
  return () => { if (panes.get(id) === w) panes.delete(id) }
}

export function writeToPane(id: string, text: string): boolean {
  return panes.get(id)?.(text) ?? false
}

/**
 * Terminals expect carriage returns. Multi-line scripts are typed line by line; with `run` the
 * last line is executed too, otherwise it is left on the prompt for review.
 */
export function toTerminalInput(script: string, run: boolean): string {
  const body = script.replace(/\r\n|\n/g, '\r').replace(/\r+$/, '')
  return run ? body + '\r' : body
}

/** The session id of each live pane: the AI assistant reads the terminal it belongs to through it. */
const sessions = new Map<string, string>()
const selections = new Map<string, () => string>()

export function setPaneSession(id: string, sid: string | null) {
  if (sid === null) { if (!sessions.delete(id)) return } else if (sessions.get(id) === sid) return
  else sessions.set(id, sid)
  version++
  watchers.forEach(f => f())
}
export const sessionOfPane = (id: string): string => sessions.get(id) ?? ''

/** What is selected in a pane, for "Use selection" in the assistant. */
export function registerSelection(id: string, get: () => string): () => void {
  selections.set(id, get)
  return () => { if (selections.get(id) === get) selections.delete(id) }
}
export const selectionOfPane = (id: string): string => selections.get(id)?.() ?? ''

/** What each live pane is doing, for the tab that holds it (a spinner while connecting, a red dot once closed). */
export type PaneStatus = 'connecting' | 'ready' | 'closed'
const statuses = new Map<string, PaneStatus>()
const watchers = new Set<() => void>()
let version = 0

export function setPaneStatus(id: string, s: PaneStatus | null) {
  if (s === null) { if (!statuses.delete(id)) return } else if (statuses.get(id) === s) return
  else statuses.set(id, s)
  version++
  watchers.forEach(f => f())
}

/** One status for a group of panes: connecting while any is, closed when all are, else ready; null when unknown. */
export function summarizeStatus(ids: string[]): PaneStatus | null {
  const all = ids.map(i => statuses.get(i)).filter((x): x is PaneStatus => !!x)
  if (all.length === 0) return null
  if (all.includes('connecting')) return 'connecting'
  return all.every(x => x === 'closed') ? 'closed' : 'ready'
}

export function watchPaneStatus(f: () => void): () => void {
  watchers.add(f)
  return () => { watchers.delete(f) }
}
export const paneStatusVersion = () => version
