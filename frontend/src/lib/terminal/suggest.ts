import type {Snippet} from '../types'

/** Where a suggestion comes from. */
export type SuggestSource = 'typed' | 'snippet' | 'host'

export interface Suggestion {
  /** what is typed when it is accepted */
  text: string
  source: SuggestSource
  /** the name of a snippet */
  label?: string
}

export interface Sources {
  /** commands typed in VVTerm, newest first */
  typed: string[]
  snippets: Snippet[]
  /** commands in the shell history of the server, newest first */
  host: string[]
}

export const MAX_SUGGESTIONS = 8

/**
 * A line that holds what looks like a secret is never suggested, whatever it came from: a suggestion is drawn on the
 * screen, and a password typed after "mysql -p" or an "export TOKEN=…" must not come back. This is the quick check
 * of the typed history; the history of a host has been through the full secret policy on the server side.
 */
const SECRETISH = /(pass(word|wd)?|secret|token|api[_-]?key|auth|credential|bearer)\s*[=:]|authorization|bearer\s+\S|\b(mysql|mysqldump|mariadb)\b.*\s-p\S|--password|[A-Za-z0-9+_-]{32,}/i
export const looksSecret = (line: string) => SECRETISH.test(line)

/** A snippet can be suggested only as one line: several lines would run the first ones as soon as they are typed. */
const oneLine = (s: string) => !/[\r\n]/.test(s.trim())

/**
 * The suggestions for what has been typed so far. Commands that start with it come first (typed in VVTerm, then
 * snippets, then the host's history, each newest first); a snippet whose name starts with it follows. Nothing is
 * suggested for text that is only spaces, and a command the same as what is typed is not a suggestion.
 */
export function suggest(prefix: string, src: Sources, limit = MAX_SUGGESTIONS): Suggestion[] {
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const add = (s: Suggestion) => {
    if (out.length >= limit || seen.has(s.text) || s.text === prefix || looksSecret(s.text)) return
    seen.add(s.text)
    out.push(s)
  }
  const empty = prefix.trim() === ''
  const starts = (c: string) => (empty ? true : c.startsWith(prefix))
  for (const c of src.typed) if (starts(c)) add({text: c, source: 'typed'})
  const snippets = src.snippets.filter(s => oneLine(s.script))
  for (const s of snippets) if (starts(s.script.trim())) add({text: s.script.trim(), source: 'snippet', label: s.label})
  for (const c of empty ? src.host.slice(0, 20) : src.host) if (starts(c)) add({text: c, source: 'host'})
  const lower = prefix.toLowerCase()
  if (!empty) for (const s of snippets) if (s.label.toLowerCase().startsWith(lower)) add({text: s.script.trim(), source: 'snippet', label: s.label})
  return out
}

/** What goes to the shell to turn what is typed into a suggestion: the missing end, or a replacement. */
export function completion(prefix: string, s: Suggestion): string {
  if (s.text.startsWith(prefix)) return s.text.slice(prefix.length)
  return '\x7f'.repeat(Array.from(prefix).length) + s.text
}

/**
 * Follows the line being typed. It is only sure about the line while the keys are letters, Backspace, Ctrl-U or Ctrl-C:
 * an arrow, Tab, a paste or anything else that lets the shell change the line by itself makes the line unknown
 * ("dirty") until Enter or Ctrl-C starts a fresh one. A suggestion is only offered while the line is known.
 */
export interface LineState {
  /** the text typed on the line */
  prefix: string
  /** false when the shell may have changed the line without us seeing it */
  known: boolean
}

export function createPrefixTracker() {
  const st: LineState = {prefix: '', known: true}
  const fresh = () => { st.prefix = ''; st.known = true }
  return {
    state: st,
    feed(data: string) {
      // a paste or a key sequence is one chunk of more than one key: the line is only certain for single keys
      // and for a short run of plain letters (what an input method sends)
      if (data.startsWith('\x1b')) { st.known = false; return }
      for (const ch of data) {
        if (ch === '\r' || ch === '\n' || ch === '\x03') fresh()
        else if (ch === '\x15') { st.prefix = ''; st.known = true }
        else if (ch === '\x7f' || ch === '\b') st.prefix = Array.from(st.prefix).slice(0, -1).join('')
        else if (ch === '\t' || ch < ' ') st.known = false
        else st.prefix += ch
      }
    },
    /** the line was read from the screen again: it is known once more */
    set(prefix: string) { st.prefix = prefix; st.known = true },
    reset: fresh,
  }
}
