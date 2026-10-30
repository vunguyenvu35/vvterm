import {completion, createPrefixTracker, suggest, type Sources, type Suggestion} from './suggest'
import {matches} from '../shortcuts/shortcuts'

/** The menu item "Show Suggestions" asks the focused pane to open or close its list with this window event. */
export const SUGGEST_POPUP = 'vvterm:suggest-popup'

/** The part of xterm's Terminal that the suggestions use (a test gives a small stand-in). */
export interface SuggestTerm {
  element?: HTMLElement
  cols: number
  rows: number
  options: {fontSize?: number; fontFamily?: string; theme?: {foreground?: string}}
  buffer?: {active: {type: string; baseY: number; cursorX: number; cursorY: number; getLine(y: number): {translateToString(trim?: boolean): string} | undefined}}
}

export interface SuggesterOptions {
  term: SuggestTerm
  /** the positioned element the pane is drawn in: the suggestions are placed inside it */
  container: HTMLElement
  /** types text into the session (the same path as the keys) */
  send(text: string): void
  sources(): Sources
  /** the Suggest setting */
  enabled(): boolean
  /** the session is connected */
  ready(): boolean
  /** key that opens the list (Settings → Shortcuts) */
  popupCombo(): string
  /** at most one redraw this often (ms) for what the terminal itself does (output, cursor moves); keys redraw at once. Default 80, 0 = none */
  throttleMs?: number
  /** a command was finished with Enter while the screen showed it on the line: it goes into the history */
  onCommand?(line: string): void
}

/** how long the screen is given to answer a key that may change the line */
const SETTLE_MS = 200

/** how many rows the list that shows by itself has */
const AUTO_ROWS = 6

/** a line this long is a paste, not a command being typed: nothing is suggested for it (and nothing is looked through) */
const MAX_PREFIX = 400

const SOURCE_NAME = {typed: 'typed', snippet: 'snippet', host: 'host'} as const

/**
 * Command suggestions drawn over a terminal as a list under the cursor while something typed matches (↑ ↓ choose a row, Enter
 * or Tab put it on the line, Esc closes; the popup key opens the list by hand, also for an empty line). Nothing is
 * offered unless the line being typed is known (see createPrefixTracker) and the screen shows it at the cursor,
 * so there is no suggestion at a password prompt, in vim, or after the shell changed the line.
 */
export function createSuggester(o: SuggesterOptions) {
  const tracker = createPrefixTracker()
  const pop = document.createElement('div')
  pop.className = 'suggest-pop'
  pop.setAttribute('role', 'listbox')
  pop.setAttribute('aria-label', 'Command suggestions')
  pop.hidden = true
  // a click on the list must not take the keyboard away from the terminal
  pop.addEventListener('mousedown', e => e.preventDefault())
  o.container.append(pop)

  let items: Suggestion[] = []
  let popupOpen = false
  let selected = 0
  /** the list that shows by itself while something typed matches (not the one the popup key opens) */
  let auto = false
  /** Esc closed that list: it stays closed until the next line */
  let listOff = false
  let lastPrefix = ''
  let raf = 0
  /** where the typing of this line began on the screen: the row, the column and what is left of it (the prompt) */
  let anchor: {row: number; col: number; text: string} | null = null
  /** when the line became unknown, and what the screen showed then */
  let lost: {at: number; shown: string} | null = null
  let settle = 0

  /** where the cursor is, in pixels inside the container, and how big a cell is */
  const geometry = () => {
    const screen = o.term.element?.querySelector('.xterm-screen') as HTMLElement | null
    const buf = o.term.buffer?.active
    if (!screen || !buf || !o.term.cols || !o.term.rows) return null
    const r = screen.getBoundingClientRect()
    const c = o.container.getBoundingClientRect()
    const cw = r.width / o.term.cols
    const ch = r.height / o.term.rows
    if (!(cw > 0) || !(ch > 0)) return null
    return {cw, ch, x: r.left - c.left + buf.cursorX * cw, y: r.top - c.top + buf.cursorY * ch, width: c.width, height: c.height}
  }

  /** the screen shows what was typed right before the cursor (the shell echoed it) */
  const echoed = (prefix: string): boolean => {
    const buf = o.term.buffer?.active
    if (!buf || buf.type !== 'normal') return false
    const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(false)
    if (line === undefined) return false
    const before = Array.from(line.slice(0, buf.cursorX)).join('')
    const tail = Array.from(prefix).slice(-30).join('')
    return before.endsWith(tail)
  }

  /** nothing is written to the right of the cursor (it is at the end of the line) */
  const nothingAfterCursor = (): boolean => {
    const buf = o.term.buffer?.active
    const line = buf?.getLine(buf.baseY + buf.cursorY)?.translateToString(true)
    return !buf || line === undefined || line.slice(buf.cursorX).trim() === ''
  }

  /**
   * Remembers where the typing began while the line is known; when the shell changes the line (Tab completes,
   * an arrow brings an older command, a paste) the text from there to the cursor is the line again, as long as
   * the prompt in front of it is the same and the cursor is still on that row.
   */
  const syncWithScreen = () => {
    const buf = o.term.buffer?.active
    if (!buf || buf.type !== 'normal') return
    const row = buf.baseY + buf.cursorY
    const line = buf.getLine(row)?.translateToString(true)
    if (line === undefined) return
    const {prefix, known} = tracker.state
    if (known) {
      if (prefix !== '' && echoed(prefix)) {
        const col = buf.cursorX - Array.from(prefix).length
        if (col >= 0) anchor = {row, col, text: line.slice(0, col)}
      }
    } else if (anchor && anchor.row === row && buf.cursorX >= anchor.col && line.slice(0, anchor.col) === anchor.text) {
      // the key has just been sent: wait for the shell to answer (the screen changes) or, when it has nothing to say
      // (Tab with nothing to complete), a moment
      const shown = line + '|' + buf.cursorX
      if (lost && shown === lost.shown && Date.now() - lost.at < SETTLE_MS) return
      lost = null
      tracker.set(line.slice(anchor.col, buf.cursorX))
    }
  }

  /**
   * The command that Enter is about to run, for the history; '' when it cannot be told. While the line is known it is
   * what was typed (the screen may not have echoed the end of it yet). When the shell changed the line (Tab completed
   * it, an arrow or its own suggestion brought a command) it is read from the screen, from where the typing began.
   * Nothing the terminal did not echo is kept: a password prompt never has an anchor.
   */
  const commandBeingRun = (): string => {
    const buf = o.term.buffer?.active
    const {prefix, known} = tracker.state
    if (known) {
      const seenOnThisRow = !!anchor && !!buf && anchor.row === buf.baseY + buf.cursorY
      return prefix.trim() !== '' && (echoed(prefix) || seenOnThisRow) ? prefix : ''
    }
    if (!buf || buf.type !== 'normal' || !anchor) return ''
    const row = buf.baseY + buf.cursorY
    const line = buf.getLine(row)?.translateToString(true)
    if (anchor.row !== row || line === undefined || line.slice(0, anchor.col) !== anchor.text) return ''
    let cmd = line.slice(anchor.col)
    // a right-hand prompt sits far to the right of the command: it is not part of it
    const rest = line.slice(buf.cursorX)
    cmd = /^\s{3,}\S/.test(rest) || rest.trim() === '' ? line.slice(anchor.col, buf.cursorX) : cmd.replace(/\s{3,}\S.*$/, '')
    return cmd.trim()
  }

  const live = () => o.enabled() && o.ready()

  const hideAll = () => { pop.hidden = true; items = []; popupOpen = false; auto = false }

  const draw = () => {
    raf = 0
    if (!o.ready()) return hideAll()
    // nothing typed, nothing shown and no list asked for: there is nothing to do (this is what runs while a program
    // writes a lot of output, so it must cost next to nothing)
    if (tracker.state.known && tracker.state.prefix === '' && !popupOpen && pop.hidden && !anchor) return
    syncWithScreen() // the history needs it too, with suggestions off
    if (!live()) return hideAll()
    const g = geometry()
    if (!g) return hideAll()
    const {prefix, known} = tracker.state
    const trusted = known && prefix !== '' && echoed(prefix) && nothingAfterCursor()

    // what matches what is typed
    const all = trusted && prefix.length <= MAX_PREFIX ? suggest(prefix, o.sources()) : []
    if (prefix !== lastPrefix) { lastPrefix = prefix; if (!popupOpen) selected = -1 }
    auto = !popupOpen && !listOff && all.length >= 1

    // the list: the one asked for, or the one that shows by itself while something typed matches
    if (popupOpen || auto) {
      items = popupOpen ? suggest(trusted || known ? prefix : '', o.sources()) : all.slice(0, AUTO_ROWS)
      if (items.length === 0) {
        // asked for and nothing matches: say so, so the key does not look broken (Esc, or typing on, closes it)
        const none = document.createElement('div')
        none.className = 'suggest-empty'
        none.textContent = 'No matching commands'
        pop.replaceChildren(none)
        pop.style.cssText = `left:${Math.max(4, Math.min(g.x, g.width - 360))}px;top:${g.y + g.ch + 4}px`
        pop.hidden = false
        return
      }
      selected = Math.min(selected, items.length - 1)
      pop.replaceChildren(...items.map((s, i) => {
        const row = document.createElement('div')
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', String(i === selected))
        row.className = 'suggest-item' + (i === selected ? ' on' : '')
        const text = document.createElement('span')
        text.className = 'suggest-text'
        text.textContent = s.text
        const badge = document.createElement('span')
        badge.className = 'suggest-src'
        badge.textContent = s.label ? `${SOURCE_NAME[s.source]} · ${s.label}` : SOURCE_NAME[s.source]
        row.append(text, badge)
        row.addEventListener('click', () => { accept(s); o.term.element?.querySelector('textarea')?.focus() })
        return row
      }))
      const below = g.y + g.ch + 4
      const height = Math.min(items.length, 8) * 28 + 8
      const top = below + height > g.height && g.y - height - 4 > 0 ? g.y - height - 4 : below
      pop.style.cssText = `left:${Math.max(4, Math.min(g.x, g.width - 360))}px;top:${top}px`
      pop.hidden = false
    } else {
      pop.hidden = true
    }
  }
  const schedule = () => { if (!raf) raf = window.requestAnimationFrame(draw) }
  // the terminal drew something: look at once when it has been quiet (the echo of a key), but not on every frame of a
  // long output: what arrives during the pause is looked at once, when it ends
  let throttled = 0
  let missed = false
  const refresh = () => {
    const ms = o.throttleMs ?? 80
    if (!ms) return schedule()
    if (throttled) { missed = true; return }
    schedule()
    throttled = window.setTimeout(() => { throttled = 0; if (missed) { missed = false; schedule() } }, ms)
  }

  function accept(s: Suggestion) {
    const {prefix, known} = tracker.state
    // an unknown line is replaced whole (Ctrl-U clears it)
    const out = known ? completion(prefix, s) : '\x15' + s.text
    popupOpen = false
    selected = -1
    o.send(out)
    tracker.feed(out)
    schedule()
  }

  function togglePopup() {
    if (!live()) return
    popupOpen = !popupOpen
    selected = 0
    schedule()
  }

  return {
    /** what the user typed (before it goes to the session) */
    feed(d: string) {
      // the line is read at the moment of Enter, while the screen still shows it: the command is kept even when
      // its output pushes it off the screen at once (ls -la). Nothing the terminal did not echo is kept (passwords).
      if (/[\r\n]/.test(d) && o.onCommand) {
        const cmd = commandBeingRun()
        if (cmd) o.onCommand(cmd)
      }
      if (/[\r\n\x03]/.test(d)) { anchor = null; listOff = false; selected = -1 }
      const was = tracker.state.known
      tracker.feed(d)
      if (was && !tracker.state.known) {
        const buf = o.term.buffer?.active
        lost = {at: Date.now(), shown: (buf?.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '') + '|' + (buf?.cursorX ?? 0)}
        window.clearTimeout(settle)
      window.clearTimeout(throttled)
        settle = window.setTimeout(schedule, SETTLE_MS + 20)
      }
      schedule()
    },
    /** the terminal drew something (output arrived or the cursor moved) */
    refresh,
    /** a key went to the terminal: true when the suggestions used it */
    handleKey(e: KeyboardEvent): boolean {
      if (e.type !== 'keydown' || !live()) return false
      if (matches(e, o.popupCombo())) {
        e.preventDefault()
        togglePopup()
        return true
      }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      if (popupOpen) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1)
          e.preventDefault(); schedule(); return true
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && plain && items[selected]) {
          e.preventDefault(); accept(items[selected]); return true
        }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); popupOpen = false; schedule(); return true }
        return false
      }
      if (auto && !pop.hidden) {
        if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          const n = items.length
          selected = e.key === 'ArrowDown' ? (selected + 1) % n : selected <= 0 ? n - 1 : selected - 1
          e.preventDefault(); schedule(); return true
        }
        // Enter only takes a row that was chosen with the arrows: otherwise it runs what is typed, as always
        if (plain && e.key === 'Enter' && selected >= 0 && items[selected]) { e.preventDefault(); accept(items[selected]); return true }
        // Tab, like Enter, only takes a row that was chosen with the arrows: otherwise it is the shell's completion
        if (plain && e.key === 'Tab' && selected >= 0 && items[selected]) { e.preventDefault(); accept(items[selected]); return true }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); listOff = true; selected = -1; schedule(); return true }
      }
      return false
    },
    /** opens the list by hand, or closes it (the popup key and the View menu) */
    togglePopup,
    /** the open list, for the pane (Esc handling) */
    isOpen: () => popupOpen,
    dispose() {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(settle)
      pop.remove()
    },
  }
}

export type Suggester = ReturnType<typeof createSuggester>
