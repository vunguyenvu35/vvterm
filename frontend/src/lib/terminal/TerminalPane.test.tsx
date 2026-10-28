import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {makeFake, Providers} from '../../test/fakeBackend'

// xterm needs a real canvas; replace it with a recording stub.
const created: any[] = []
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100; rows = 30; options: any = {}
    written: Uint8Array[] = []
    dataCb: (d: string) => void = () => {}
    keyHandler: (e: any) => boolean = () => true
    constructor() { created.push(this) }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() { (this as any).disposed = true }
    write(b: Uint8Array) { this.written.push(b) }
    onData(cb: any) { this.dataCb = cb }
    onResize() {}
    attachCustomKeyEventHandler(h: any) { this.keyHandler = h }
    selection = ''
    selectionCb: () => void = () => {}
    pasted: string[] = []
    selectedAll = false
    cleared = false
    getSelection() { return this.selection }
    hasSelection() { return this.selection !== '' }
    onSelectionChange(cb: () => void) { this.selectionCb = cb; return {dispose() {}} }
    paste(t: string) { this.pasted.push(t) }
    selectAll() { this.selectedAll = true }
    clear() { this.cleared = true }
  },
}))
vi.mock('@xterm/addon-fit', () => ({FitAddon: class { fit() {} }}))
vi.mock('@xterm/addon-search', () => ({SearchAddon: class { findNext = vi.fn(); findPrevious = vi.fn() }}))
vi.mock('@xterm/addon-web-links', () => ({WebLinksAddon: class {}}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import {TerminalPane} from './TerminalPane'

const props = {hostId: 'h1', visible: true, focused: true, fontSize: 13, fontFamily: 'monospace', termTheme: {background: '#000000'}, cursorStyle: 'block' as const, cursorBlink: true, scrollback: 10000}

async function mount() {
  const be = makeFake()
  const onExit = vi.fn()
  const view = render(<Providers be={be}><TerminalPane {...props} onFocus={vi.fn()} onExit={onExit} /></Providers>)
  await waitFor(() => expect(be.state.calls.some(c => c[0] === 'session.attach')).toBe(true))
  const sid = be.state.calls.find(c => c[0] === 'session.attach')![1] as string
  return {be, onExit, sid, term: created[created.length - 1], view}
}

describe('TerminalPane', () => {
  beforeEach(() => { created.length = 0 })

  it('opens a session, attaches after subscribing, and renders output bytes', async () => {
    const {be, sid, term} = await mount()
    expect(be.state.calls[0]).toEqual(['session.open', 'h1', 100, 30])
    act(() => be.emit(`term:data:${sid}`, btoa('hello\x1b[0m')))
    expect(Array.from(term.written[0])).toEqual(Array.from(new TextEncoder().encode('hello\x1b[0m')))
  })

  it('sends keystrokes only once the session is ready', async () => {
    const {be, sid, term} = await mount()
    term.dataCb('x')
    expect(be.state.calls.some(c => c[0] === 'session.write')).toBe(false)
    act(() => be.emit(`term:ready:${sid}`, {}))
    term.dataCb('ls\r')
    expect(be.state.calls).toContainEqual(['session.write', sid, 'ls\r'])
  })

  it('asks for host key confirmation and answers with the displayed fingerprint', async () => {
    const {be, sid} = await mount()
    act(() => be.emit(`term:hostkey:${sid}`, {host: 'srv:22', fingerprint: 'SHA256:xyz', key_type: 'ssh-ed25519'}))
    expect(screen.getByTestId('fingerprint')).toHaveTextContent('SHA256:xyz')
    await userEvent.click(screen.getByRole('button', {name: 'Trust and connect'}))
    expect(be.state.calls).toContainEqual(['session.trustHostKey', sid, 'SHA256:xyz'])
    expect(screen.queryByTestId('fingerprint')).toBeNull()
  })

  it('rejecting the host key sends an empty fingerprint', async () => {
    const {be, sid} = await mount()
    act(() => be.emit(`term:hostkey:${sid}`, {host: 'srv', fingerprint: 'SHA256:xyz', key_type: 'k'}))
    await userEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    expect(be.state.calls).toContainEqual(['session.trustHostKey', sid, ''])
  })

  it('shows the connection-lost banner and reconnects only on Enter', async () => {
    const {be, sid, term} = await mount()
    act(() => be.emit(`term:ready:${sid}`, {}))
    act(() => be.emit(`term:closed:${sid}`, {reason: 'connection lost: EOF', clean: false}))
    expect(screen.getByRole('alert')).toHaveTextContent('connection lost')
    expect(screen.getByRole('alert')).toHaveTextContent('Press Enter to reconnect')
    expect(be.state.calls.some(c => c[0] === 'session.reconnect')).toBe(false) // no automatic reconnect
    term.dataCb('a') // other keys do nothing
    expect(be.state.calls.some(c => c[0] === 'session.reconnect')).toBe(false)
    term.dataCb('\r')
    expect(be.state.calls).toContainEqual(['session.reconnect', sid])
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('a clean exit asks the parent to remove the pane', async () => {
    const {be, sid, onExit} = await mount()
    act(() => be.emit(`term:closed:${sid}`, {reason: 'session ended', clean: true}))
    expect(onExit).toHaveBeenCalled()
  })

  it('closes the session and disposes xterm on unmount', async () => {
    const {be, sid, term, view} = await mount()
    view.unmount()
    expect(be.state.calls).toContainEqual(['session.close', sid])
    expect(term.disposed).toBe(true)
  })

  it('shows an error banner if opening fails', async () => {
    const be = makeFake()
    be.session.open = async () => { throw 'host: record not found' }
    render(<Providers be={be}><TerminalPane {...props} onFocus={vi.fn()} onExit={vi.fn()} /></Providers>)
    expect(await screen.findByRole('alert')).toHaveTextContent('record not found')
  })

  it('opens the search bar with Ctrl+F', async () => {
    const {term} = await mount()
    act(() => { term.keyHandler({type: 'keydown', ctrlKey: true, metaKey: false, key: 'f'}) })
    expect(await screen.findByLabelText('Search terminal')).toBeInTheDocument()
  })
})

describe('TerminalPane snippet writer', () => {
  beforeEach(() => { created.length = 0 })

  it('registers by pane id, types only when ready, and unregisters on unmount', async () => {
    const {writeToPane} = await import('./panes')
    const be = makeFake()
    const view = render(<Providers be={be}><TerminalPane {...props} paneId="pane-x" onFocus={vi.fn()} onExit={vi.fn()} /></Providers>)
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'session.attach')).toBe(true))
    const sid = be.state.calls.find(c => c[0] === 'session.attach')![1] as string
    expect(writeToPane('pane-x', 'ls\r')).toBe(false) // still connecting
    act(() => be.emit(`term:ready:${sid}`, {}))
    expect(writeToPane('pane-x', 'ls\r')).toBe(true)
    expect(be.state.calls).toContainEqual(['session.write', sid, 'ls\r'])
    view.unmount()
    expect(writeToPane('pane-x', 'x')).toBe(false)
  })
})

describe('TerminalPane: keystroke order', () => {
  beforeEach(() => { created.length = 0 })

  // Regression: typing "echo" reached the shell as "ceho" because every key was its own call, and calls
  // that are in flight together may be run in any order.
  it('sends one call at a time, in order, and what was typed meanwhile goes out together', async () => {
    const {be, sid, term} = await mount()
    act(() => be.emit(`term:ready:${sid}`, {}))
    const sent: string[] = []
    const releases: Array<() => void> = []
    be.session.write = (_s, d) => { sent.push(d); return new Promise<void>(r => releases.push(r)) }
    term.dataCb('e'); term.dataCb('c'); term.dataCb('h'); term.dataCb('o')
    expect(sent).toEqual(['e']) // the others wait for the first call to finish
    releases[0]()
    await waitFor(() => expect(sent).toEqual(['e', 'cho']))
    term.dataCb('\r')
    releases[1]()
    await waitFor(() => expect(sent).toEqual(['e', 'cho', '\r']))
    releases[2]()
    term.dataCb('x')
    await waitFor(() => expect(sent.at(-1)).toBe('x')) // and it goes back to sending at once when idle
  })

  it('a failed call does not block the ones after it', async () => {
    const {be, sid, term} = await mount()
    act(() => be.emit(`term:ready:${sid}`, {}))
    const sent: string[] = []
    be.session.write = (_s, d) => { sent.push(d); return sent.length === 1 ? Promise.reject(new Error('boom')) : Promise.resolve() }
    term.dataCb('a')
    term.dataCb('b')
    await waitFor(() => expect(sent).toEqual(['a', 'b']))
  })

  it('snippets are typed through the same ordered queue, after what is already on its way', async () => {
    const be = makeFake()
    render(<Providers be={be}><TerminalPane {...props} paneId="pane-q" onFocus={vi.fn()} onExit={vi.fn()} /></Providers>)
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'session.attach')).toBe(true))
    const sid = be.state.calls.find(c => c[0] === 'session.attach')![1] as string
    act(() => be.emit('term:ready:' + sid, {}))
    const {writeToPane} = await import('./panes')
    const sent: string[] = []
    const releases: Array<() => void> = []
    be.session.write = (_s, d) => { sent.push(d); return new Promise<void>(r => releases.push(r)) }
    const term = created[created.length - 1]
    term.dataCb('c')
    expect(writeToPane('pane-q', 'df -h\r')).toBe(true)
    expect(sent).toEqual(['c']) // the snippet waits its turn
    releases[0]()
    await waitFor(() => expect(sent).toEqual(['c', 'df -h\r']))
  })
})

describe('TerminalPane: copy on select, right click, copy and paste keys', () => {
  beforeEach(() => { created.length = 0 })
  const keydown = (init: KeyboardEventInit) => new KeyboardEvent('keydown', {cancelable: true, ...init})
  const ctrlShift = (key: string) => keydown({key, code: 'Key' + key.toUpperCase(), ctrlKey: true, shiftKey: true})

  async function mountWith(extra: Partial<React.ComponentProps<typeof TerminalPane>> = {}) {
    const be = makeFake()
    render(<Providers be={be}><TerminalPane {...props} {...extra} onFocus={vi.fn()} onExit={vi.fn()} /></Providers>)
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'session.attach')).toBe(true))
    const sid = be.state.calls.find(c => c[0] === 'session.attach')![1] as string
    act(() => be.emit('term:ready:' + sid, {}))
    return {be, sid, term: created[created.length - 1]}
  }
  const wrote = (be: ReturnType<typeof makeFake>) => be.state.calls.filter(c => c[0] === 'system.writeClipboard').map(c => c[1])

  it('copies the selection once it stops changing (copy on select)', async () => {
    const {be, term} = await mountWith()
    term.selection = 'he'; term.selectionCb()
    term.selection = 'hello'; term.selectionCb() // dragging: only the last one counts
    await waitFor(() => expect(wrote(be)).toEqual(['hello']))
    expect(be.state.clipboard).toBe('hello')
  })

  it('does nothing when copy on select is off, or the selection was cleared', async () => {
    const off = await mountWith({copyOnSelect: false})
    off.term.selection = 'x'; off.term.selectionCb()
    await new Promise(r => setTimeout(r, 300))
    expect(wrote(off.be)).toEqual([])
    const cleared = await mountWith()
    cleared.term.selection = ''; cleared.term.selectionCb()
    await new Promise(r => setTimeout(r, 300))
    expect(wrote(cleared.be)).toEqual([])
  })

  it('the copy key copies the selection and is not sent to the shell; with nothing selected it passes through', async () => {
    const {be, term} = await mountWith()
    term.selection = 'abc'
    const e = ctrlShift('c')
    expect(term.keyHandler(e)).toBe(false)
    expect(e.defaultPrevented).toBe(true)
    expect(wrote(be)).toEqual(['abc'])
    term.selection = ''
    expect(term.keyHandler(ctrlShift('c'))).toBe(true) // the shell gets it (Ctrl+C stays the interrupt)
    expect(wrote(be)).toEqual(['abc'])
  })

  it('Next / Previous tab are not sent to the shell: the terminal lets them through to the app', async () => {
    const {be, term} = await mountWith({appCombos: ['Ctrl+Tab', 'Ctrl+Shift+Tab']})
    expect(term.keyHandler(keydown({key: 'Tab', code: 'Tab', ctrlKey: true}))).toBe(false)
    expect(term.keyHandler(keydown({key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true}))).toBe(false)
    expect(term.keyHandler(keydown({key: 'Tab', code: 'Tab'}))).toBe(true) // a plain Tab is completion
    expect(term.keyHandler(keydown({key: 'd', code: 'KeyD', ctrlKey: true}))).toBe(true) // Ctrl+D stays the shell's
    expect(wrote(be)).toEqual([])
  })

  it('the copy and paste combinations can be changed', async () => {
    const {be, term} = await mountWith({copyCombo: 'Alt+Y', pasteCombo: 'Alt+P'})
    term.selection = 'sel'
    expect(term.keyHandler(ctrlShift('c'))).toBe(true) // the old default no longer does anything
    expect(term.keyHandler(keydown({key: 'y', code: 'KeyY', altKey: true}))).toBe(false)
    expect(wrote(be)).toEqual(['sel'])
    be.state.clipboard = 'from clipboard'
    expect(term.keyHandler(keydown({key: 'p', code: 'KeyP', altKey: true}))).toBe(false)
    await waitFor(() => expect(term.pasted).toEqual(['from clipboard']))
  })

  it('the paste key pastes the clipboard into the terminal, only when connected', async () => {
    const {be, term, sid} = await mountWith()
    be.state.clipboard = 'echo pasted\\nls'
    const e = ctrlShift('v')
    expect(term.keyHandler(e)).toBe(false)
    expect(e.defaultPrevented).toBe(true)
    await waitFor(() => expect(term.pasted).toEqual(['echo pasted\\nls']))
    act(() => be.emit('term:closed:' + sid, {reason: 'x', clean: false}))
    term.keyHandler(ctrlShift('v'))
    await new Promise(r => setTimeout(r, 50))
    expect(term.pasted).toHaveLength(1) // not connected: nothing is typed anywhere
  })

  it('a right click pastes by default, and never shows the browser menu', async () => {
    const {be, term} = await mountWith()
    be.state.clipboard = 'right-click paste'
    const ev = new MouseEvent('contextmenu', {bubbles: true, cancelable: true})
    screen.getByTestId('pane').dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    await waitFor(() => expect(term.pasted).toEqual(['right-click paste']))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('right click = none does nothing at all', async () => {
    const {be, term} = await mountWith({rightClick: 'none'})
    be.state.clipboard = 'x'
    const ev = new MouseEvent('contextmenu', {bubbles: true, cancelable: true})
    screen.getByTestId('pane').dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    await new Promise(r => setTimeout(r, 50))
    expect(term.pasted).toEqual([])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('right click = menu shows Copy, Paste, Select all and Clear where you clicked', async () => {
    const {be, term} = await mountWith({rightClick: 'menu'})
    be.state.clipboard = 'menu paste'
    fireEvent.contextMenu(screen.getByTestId('pane'), {clientX: 40, clientY: 60})
    const menu = screen.getByRole('menu', {name: 'Terminal'})
    expect(menu).toHaveStyle({left: '40px', top: '60px'})
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Copy', 'Paste', 'Select all', 'Clear'])
    expect(within(menu).getByRole('menuitem', {name: 'Copy'})).toBeDisabled() // nothing selected
    await userEvent.click(within(menu).getByRole('menuitem', {name: 'Paste'}))
    await waitFor(() => expect(term.pasted).toEqual(['menu paste']))
    expect(screen.queryByRole('menu')).toBeNull()
    term.selection = 'picked'
    fireEvent.contextMenu(screen.getByTestId('pane'), {clientX: 1, clientY: 2})
    await userEvent.click(screen.getByRole('menuitem', {name: 'Copy'}))
    expect(wrote(be)).toContain('picked')
    fireEvent.contextMenu(screen.getByTestId('pane'), {clientX: 1, clientY: 2})
    await userEvent.click(screen.getByRole('menuitem', {name: 'Select all'}))
    expect(term.selectedAll).toBe(true)
    fireEvent.contextMenu(screen.getByTestId('pane'), {clientX: 1, clientY: 2})
    await userEvent.click(screen.getByRole('menuitem', {name: 'Clear'}))
    expect(term.cleared).toBe(true)
  })

  it('the menu closes on Escape and on a click elsewhere', async () => {
    await mountWith({rightClick: 'menu'})
    fireEvent.contextMenu(screen.getByTestId('pane'), {clientX: 5, clientY: 5})
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(window, {key: 'Escape'})
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('pane'), {clientX: 5, clientY: 5})
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('TerminalPane: the connecting screen', () => {
  beforeEach(() => { created.length = 0 })
  const info = {label: 'web-1', os: 'ubuntu', subtitle: 'SSH w1.example.com:22'}
  async function mountWith(extra = {}) {
    const be = makeFake()
    render(<Providers be={be}><TerminalPane {...props} connect={info} onShowLogs={vi.fn()} onCloseTab={vi.fn()} onFocus={vi.fn()} onExit={vi.fn()} {...extra} /></Providers>)
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'session.attach')).toBe(true))
    return {be, sid: be.state.calls.find(c => c[0] === 'session.attach')![1] as string}
  }
  const bar = () => document.querySelector('.connect-track .line i') as HTMLElement | null
  const at = () => Number(bar()!.getAttribute('data-progress'))
  const sleep = (ms: number) => act(() => new Promise<void>(r => setTimeout(r, ms)))

  it('shows who it connects to, and a line that creeps along without ever jumping', async () => {
    await mountWith()
    const screenEl = screen.getByRole('status', {name: 'Connecting'})
    expect(within(screenEl).getByText('web-1')).toBeInTheDocument()
    expect(within(screenEl).getByText('SSH w1.example.com:22')).toBeInTheDocument()
    expect(within(screenEl).getByRole('button', {name: 'Show logs'})).toBeInTheDocument()
    expect(within(screenEl).getByRole('button', {name: 'Close'})).toBeInTheDocument()
    await waitFor(() => expect(at()).toBeGreaterThan(0))
    const samples: number[] = []
    for (let k = 0; k < 6; k++) { await sleep(60); samples.push(at()) }
    for (let k = 1; k < samples.length; k++) {
      expect(samples[k]).toBeGreaterThanOrEqual(samples[k - 1]) // forward only
      expect(samples[k] - samples[k - 1]).toBeLessThan(0.05) // in small steps
    }
    expect(at()).toBeLessThan(0.55) // it does not reach its target while the backend is still working
  })

  it('the target moves on when the backend says the login is done, and the line follows smoothly', async () => {
    const {be, sid} = await mountWith()
    expect(bar()).toHaveAttribute('data-target', '0.55')
    act(() => be.emit('term:progress:' + sid, {stage: 'authenticated'}))
    await waitFor(() => expect(bar()).toHaveAttribute('data-target', '0.92'))
    expect(screen.getByText('Opening the shell…')).toBeInTheDocument()
    const before = at()
    await sleep(80)
    expect(at() - before).toBeLessThan(0.1) // no jump to the new target
  })

  it('when the session is ready the line runs the rest of the way, and the terminal shows when it has arrived', async () => {
    const {be, sid} = await mountWith()
    act(() => be.emit('term:ready:' + sid, {}))
    expect(bar()).toHaveAttribute('data-target', '1')
    expect(screen.getByRole('status', {name: 'Connecting'})).toBeInTheDocument() // not gone at once
    await waitFor(() => expect(screen.queryByRole('status', {name: 'Connecting'})).toBeNull(), {timeout: 4000})
  })

  it('a failure stops the line where it was and shows the error with Retry, Show logs and Close', async () => {
    const {be, sid} = await mountWith()
    await sleep(120)
    act(() => be.emit('term:closed:' + sid, {reason: 'ssh: handshake failed: unable to authenticate', clean: false}))
    const failed = await screen.findByLabelText('Connection failed')
    expect(within(failed).getByRole('alert')).toHaveTextContent('unable to authenticate')
    expect(failed.querySelector('.connect-track')).toHaveClass('failed')
    const stopped = at()
    await sleep(120)
    expect(at()).toBe(stopped) // frozen
    expect(stopped).toBeLessThan(0.55)
    expect(within(failed).getByRole('button', {name: 'Show logs'})).toBeInTheDocument()
    expect(within(failed).getByRole('button', {name: 'Close'})).toBeInTheDocument()
    await userEvent.click(within(failed).getByRole('button', {name: 'Retry'}))
    expect(be.state.calls.some(c => c[0] === 'session.reconnect')).toBe(true)
    expect(await screen.findByRole('status', {name: 'Connecting'})).toBeInTheDocument()
    expect(screen.queryByLabelText('Connection failed')).toBeNull()
    await waitFor(() => expect(at()).toBeLessThan(stopped)) // a new try starts from the plug again
  })

  it('a connection lost after it was up keeps the old banner, not the connecting screen', async () => {
    const {be, sid} = await mountWith()
    act(() => be.emit('term:ready:' + sid, {}))
    await waitFor(() => expect(screen.queryByRole('status', {name: 'Connecting'})).toBeNull(), {timeout: 4000})
    act(() => be.emit('term:closed:' + sid, {reason: 'connection lost: EOF', clean: false}))
    expect(await screen.findByText('Press Enter to reconnect')).toBeInTheDocument()
    expect(screen.queryByLabelText('Connection failed')).toBeNull()
  })
})
