import {act, render, screen, waitFor} from '@testing-library/react'
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
