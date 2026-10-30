import {createSuggester, type SuggestTerm} from './suggester'
import type {Snippet} from '../types'

const COLS = 80
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})
const CTRL_SPACE = {key: ' ', code: 'Space', ctrlKey: true}

/** animation frames wait until the test lets them run, like a browser's */
let frames: FrameRequestCallback[] = []
const flush = () => { const run = frames; frames = []; run.forEach(cb => cb(0)) }

function setup(o: {line?: string; cursorX?: number; type?: string; enabled?: boolean; ready?: boolean; typed?: string[]; snippets?: Snippet[]} = {}) {
  const container = document.createElement('div')
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () => ({left: 0, top: 0, width: COLS * 10, height: 24 * 20, right: 0, bottom: 0, x: 0, y: 0, toJSON() {}}) as DOMRect
  element.append(screen)
  container.getBoundingClientRect = () => ({left: 0, top: 0, width: 800, height: 480, right: 0, bottom: 0, x: 0, y: 0, toJSON() {}}) as DOMRect
  document.body.append(container)
  const state = {line: o.line ?? '$ ', cursorX: o.cursorX ?? 2, type: o.type ?? 'normal', enabled: o.enabled ?? true, ready: o.ready ?? true}
  const term = {
    element, cols: COLS, rows: 24, options: {fontSize: 13, fontFamily: 'monospace', theme: {foreground: '#ddd'}},
    get buffer() { return {active: {type: state.type, baseY: 0, cursorX: state.cursorX, cursorY: 0, getLine: () => ({translateToString: (trim?: boolean) => (trim ? state.line.trimEnd() : state.line)})}} },
  } as unknown as SuggestTerm
  const sent: string[] = []
  const commands: string[] = []
  const raw = createSuggester({
    term, container, send: d => sent.push(d),
    sources: () => ({typed: o.typed ?? ['git status', 'git stash', 'ls -la'], snippets: o.snippets ?? [], host: []}),
    enabled: () => state.enabled, ready: () => state.ready, popupCombo: () => 'Ctrl+Space', onCommand: c => commands.push(c),
  })
  const s = {
    feed: (d: string) => { raw.feed(d); flush() },
    refresh: () => { raw.refresh(); flush() },
    handleKey: (e: KeyboardEvent) => { const r = raw.handleKey(e); flush(); return r },
    isOpen: raw.isOpen,
    togglePopup: () => { raw.togglePopup(); flush() },
    dispose: raw.dispose,
  }
  /** the user types: the keys reach the suggester and the shell echoes them */
  const type = (text: string) => { s.feed(text); state.line += text; state.cursorX += text.length; s.refresh() }
  const pop = () => container.querySelector('.suggest-pop') as HTMLElement
  const options = () => Array.from(container.querySelectorAll('[role=option]')).map(e => e.textContent)
  return {s, sent, commands, state, type, pop, options, container}
}

const SEL = '[aria-selected=true]'

describe('createSuggester', () => {
  beforeEach(() => { frames = []; vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb)); vi.stubGlobal('cancelAnimationFrame', () => {}) })
  afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

  it('lists what matches what is typed, with the source of each, as soon as a command matches', () => {
    const t = setup({snippets: [{id: 's', label: 'Stat', script: 'git status -sb'} as unknown as Snippet]})
    t.type('git s')
    expect(t.pop().hidden).toBe(false)
    expect(t.options()).toEqual(['git statustyped', 'git stashtyped', 'git status -sbsnippet · Stat'])
    expect(t.pop().querySelector(SEL)).toBeNull() // no row is chosen until an arrow is pressed
    expect(t.container.querySelector('.suggest-ghost')).toBeNull() // there is no dimmed text
    t.type('tat')
    expect(t.options()).toEqual(['git statustyped', 'git status -sbsnippet · Stat'])
    t.type('us -s')
    expect(t.options()).toEqual(['git status -sbsnippet · Stat'])
  })

  it('shows nothing when nothing matches, and the keys stay the shell\'s', () => {
    const t = setup()
    t.type('zzz')
    expect(t.pop().hidden).toBe(true)
    for (const k of ['Tab', 'ArrowDown', 'ArrowRight', 'Enter']) expect(t.s.handleKey(key({key: k}))).toBe(false)
  })

  it('offers nothing when the screen does not show what was typed (a password prompt)', () => {
    const t = setup({line: 'Password: '})
    t.s.feed('git st') // typed, but the terminal echoed nothing
    t.s.refresh()
    expect(t.pop().hidden).toBe(true)
  })

  it('offers nothing in a full-screen program', () => {
    const t = setup({type: 'alternate'})
    t.type('git st')
    expect(t.pop().hidden).toBe(true)
  })

  it('offers nothing while the cursor is in the middle of a line', () => {
    const t = setup()
    t.type('git st')
    t.state.line = '$ git stXYZ'; t.state.cursorX = 8
    t.s.refresh()
    expect(t.pop().hidden).toBe(true)
  })

  it('is silent when switched off or while the session is not connected', () => {
    const t = setup({enabled: false})
    t.type('git st')
    expect(t.pop().hidden).toBe(true)
    expect(t.s.handleKey(key(CTRL_SPACE))).toBe(false)
    const u = setup({ready: false})
    u.type('git st')
    expect(u.pop().hidden).toBe(true)
  })

  it('lists after a space too: "git " is found before the cursor even though the screen trims the end', () => {
    const t = setup()
    t.type('git ')
    expect(t.options()).toEqual(['git statustyped', 'git stashtyped'])
  })

  it('leaves Enter and the arrows to the shell until a row is chosen with the arrows; the chosen row is put on the line, not run', () => {
    const t = setup()
    t.type('git s')
    const enter = key({key: 'Enter'})
    expect(t.s.handleKey(enter)).toBe(false) // runs what is typed, as always
    expect(enter.defaultPrevented).toBe(false)
    expect(t.s.handleKey(key({key: 'ArrowDown'}))).toBe(true)
    expect(t.pop().querySelector(SEL)?.textContent).toBe('git statustyped')
    t.s.handleKey(key({key: 'ArrowDown'}))
    expect(t.pop().querySelector(SEL)?.textContent).toBe('git stashtyped')
    expect(t.s.handleKey(key({key: 'Enter'}))).toBe(true)
    expect(t.sent).toEqual(['tash']) // "git s" + "tash"
  })

  it('Tab is the shell\'s until a row is chosen with the arrows, then it takes that row; ArrowUp starts from the last row', () => {
    const a = setup()
    a.type('git s')
    const tab = key({key: 'Tab'})
    expect(a.s.handleKey(tab)).toBe(false) // nothing was chosen: the shell completes
    expect(tab.defaultPrevented).toBe(false)
    expect(a.sent).toEqual([])
    const b = setup()
    b.type('git s')
    b.s.handleKey(key({key: 'ArrowUp'}))
    expect(b.pop().querySelector(SEL)?.textContent).toBe('git stashtyped')
    const chosenTab = key({key: 'Tab'})
    expect(b.s.handleKey(chosenTab)).toBe(true)
    expect(chosenTab.defaultPrevented).toBe(true)
    expect(b.sent).toEqual(['tash'])
  })

  it('→ is always the shell\'s', () => {
    const t = setup()
    t.type('git s')
    expect(t.s.handleKey(key({key: 'ArrowRight'}))).toBe(false)
  })

  it('Esc closes the list for the rest of the line and the next line brings it back', () => {
    const t = setup()
    t.type('git s')
    expect(t.s.handleKey(key({key: 'Escape'}))).toBe(true)
    expect(t.pop().hidden).toBe(true)
    t.type('t')
    expect(t.pop().hidden).toBe(true)
    expect(t.s.handleKey(key({key: 'Escape'}))).toBe(false) // nothing to close: the shell gets it
    t.s.feed('\r')
    t.state.line = '$ '; t.state.cursorX = 2
    t.type('git s')
    expect(t.pop().hidden).toBe(false)
  })

  it('reads the line from the screen again after an arrow key brings an older command', () => {
    const t = setup()
    t.type('git st')
    t.s.feed('\x1b[A')
    t.state.line = '$ ls'; t.state.cursorX = 4 // the shell replaced the line
    t.s.refresh()
    expect(t.options()).toEqual(['ls -latyped'])
  })

  it('keeps listing after Tab completes something, with the new text as the line', () => {
    const t = setup({typed: ['cd /etc/nginx', 'ls -la']})
    t.type('cd /e')
    t.s.feed('\t')
    t.state.line = '$ cd /etc/'; t.state.cursorX = 10 // the shell completed it
    t.s.refresh()
    expect(t.options()).toEqual(['cd /etc/nginxtyped'])
  })

  it('reads the line again a moment after a key the shell had nothing to answer (Tab with nothing to complete)', () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      t.type('git st')
      t.s.feed('\t') // the screen does not change
      expect(t.pop().hidden).toBe(true)
      vi.advanceTimersByTime(260)
      t.s.refresh()
      expect(t.options()).toEqual(['git statustyped', 'git stashtyped'])
    } finally { vi.useRealTimers() }
  })

  it('does not guess when the first key of a line was Tab or an arrow: the prompt is not known', () => {
    const t = setup()
    t.s.feed('\t')
    t.type('gi')
    expect(t.pop().hidden).toBe(true)
    t.s.feed('\r')
    t.state.line = '$ '; t.state.cursorX = 2
    t.type('ls')
    expect(t.options()).toEqual(['ls -latyped']) // a new line is known again
  })

  it('the popup key opens the list by hand, also for an empty line; Enter takes the first row, Esc closes', () => {
    const t = setup()
    expect(t.s.handleKey(key(CTRL_SPACE))).toBe(true)
    expect(t.options()).toEqual(['git statustyped', 'git stashtyped', 'ls -latyped'])
    expect(t.pop().querySelector(SEL)?.textContent).toBe('git statustyped')
    expect(t.s.handleKey(key({key: 'Escape'}))).toBe(true)
    expect(t.s.isOpen()).toBe(false)
    t.s.handleKey(key(CTRL_SPACE))
    t.s.handleKey(key({key: 'Enter'}))
    expect(t.sent).toEqual(['git status']) // an empty line: the whole command
  })

  it('the View menu opens and closes the list the same way as the key (togglePopup)', () => {
    const t = setup()
    t.type('git s')
    t.s.togglePopup()
    expect(t.s.isOpen()).toBe(true)
    expect(t.pop().querySelector(SEL)).not.toBeNull() // opened by hand: the first row is chosen
    t.s.togglePopup()
    expect(t.s.isOpen()).toBe(false)
    const off = setup({enabled: false})
    off.s.togglePopup()
    expect(off.s.isOpen()).toBe(false) // nothing opens while suggestions are off
  })

  it('says so when the list was asked for and nothing matches', () => {
    const t = setup({typed: [], snippets: []})
    t.type('zzz')
    t.s.handleKey(key(CTRL_SPACE))
    expect(t.pop().textContent).toBe('No matching commands')
    expect(t.s.handleKey(key({key: 'Escape'}))).toBe(true)
    expect(t.pop().hidden).toBe(true)
  })

  it('replaces the whole line with Ctrl-U when the line is not known', () => {
    const t = setup()
    t.s.feed('\t') // the first key of the line was Tab: the line is not known
    t.type('gi')
    t.s.handleKey(key(CTRL_SPACE))
    t.s.handleKey(key({key: 'Enter'}))
    expect(t.sent).toEqual(['\x15git status'])
  })

  it('a replacement for a snippet name deletes what was typed first', () => {
    const t = setup({typed: [], snippets: [{id: 's', label: 'Cleanup', script: 'rm -rf /tmp/c'} as unknown as Snippet]})
    t.type('clea')
    expect(t.options()).toEqual(['rm -rf /tmp/csnippet · Cleanup'])
    t.s.handleKey(key({key: 'ArrowDown'}))
    t.s.handleKey(key({key: 'Tab'}))
    expect(t.sent).toEqual(['\x7f\x7f\x7f\x7frm -rf /tmp/c'])
  })

  it('keeps a command when Enter is pressed, and nothing the terminal did not echo', () => {
    const t = setup()
    t.type('ls -la')
    t.s.feed('\r')
    expect(t.commands).toEqual(['ls -la'])
    t.state.line = 'Password: '; t.state.cursorX = 10 // a prompt that shows nothing of what is typed
    t.s.feed('hunter2')
    t.s.feed('\r')
    expect(t.commands).toEqual(['ls -la'])
    const u = setup()
    u.s.feed('\r') // an empty line
    expect(u.commands).toEqual([])
  })

  it('keeps the command when Enter comes before the end of the line is echoed, once the line has been seen on the screen', () => {
    const t = setup()
    t.type('ls')
    t.s.feed(' -la') // typed fast: the screen still shows "ls"
    t.s.feed('\r')
    expect(t.commands).toEqual(['ls -la'])
  })

  describe('the history keeps the command that ran, not the keys that were pressed', () => {
    it('Tab completion: the completed line', () => {
      const t = setup()
      t.type('cd Da')
      t.s.feed('\t')
      t.state.line = '$ cd Data/'; t.state.cursorX = 10
      t.s.refresh()
      t.s.feed('\r')
      expect(t.commands).toEqual(['cd Data/'])
    })

    it('a command the shell suggested and → accepted: the whole command, even if Enter comes before the redraw', () => {
      const t = setup()
      t.type('y d')
      t.s.feed('\x1b[C')
      t.state.line = '$ yarn dev'; t.state.cursorX = 10 // the shell wrote the rest
      t.s.feed('\r') // no refresh in between
      expect(t.commands).toEqual(['yarn dev'])
    })

    it('a right-hand prompt on the line is not part of the command', () => {
      const t = setup()
      t.type('ls -la')
      t.s.feed('\x1b[C')
      t.state.line = '$ ls -la                          vuvn 11:30'; t.state.cursorX = 8
      t.s.feed('\r')
      expect(t.commands).toEqual(['ls -la'])
    })

    it('nothing from a line the typing of which was never seen on the screen (a password prompt)', () => {
      const t = setup({line: 'Password: '})
      t.s.feed('hunter2')
      t.s.feed('\x1b[C')
      t.s.feed('\r')
      expect(t.commands).toEqual([])
    })
  })

  it('removes what it drew when it is disposed', () => {
    const t = setup()
    t.s.dispose()
    expect(t.container.querySelector('.suggest-pop')).toBeNull()
  })
})
