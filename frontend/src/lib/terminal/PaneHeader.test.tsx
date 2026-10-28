import {fireEvent, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {host} from '../../test/fakeBackend'
import {DEFAULT_SETTINGS} from '../settings/defaults'
import {newTab, splitPane, leaves, toggleBroadcast, toggleZoom, type Tab} from '../layout'

const mounts: string[] = []
const typedHooks = new Map<string, ((d: string) => void) | undefined>()
vi.mock('./TerminalPane', async () => {
  const {useEffect} = await import('react')
  return {
    TerminalPane: (p: {paneId?: string; hostId: string; visible: boolean; onTyped?(d: string): void}) => {
      useEffect(() => { mounts.push('mount:' + p.paneId); return () => { mounts.push('unmount:' + p.paneId) } }, [p.paneId])
      typedHooks.set(p.paneId!, p.onTyped)
      return <div data-testid={'term-' + p.paneId} data-visible={String(p.visible)} />
    },
  }
})
vi.mock('../sftp/SftpBrowser', () => ({SftpBrowser: () => <div />}))

import {Workspace} from './Workspace'
import {registerPane} from './panes'

const base = {activeTab: 't', settings: DEFAULT_SETTINGS, appearance: 'dark' as const, shortcuts: {broadcast_input: 'Mod+Alt+B'}}

function two(): {tab: Tab; ids: string[]} {
  let tab = {...newTab('h1', 'web'), id: 't'}
  tab = splitPane(tab, tab.activePane, 'row')
  return {tab, ids: leaves(tab.root).map(l => l.id)}
}
const hosts = [host({id: 'h1', label: 'web-1', username: 'root', os: 'ubuntu', telnet_enabled: true} as never)]

function mount(tab: Tab, over: Partial<React.ComponentProps<typeof Workspace>> = {}) {
  const cb = {onFocusPane: vi.fn(), onPaneExit: vi.fn(), onClosePane: vi.fn(), onToggleBroadcast: vi.fn(), onToggleZoom: vi.fn()}
  const view = render(<Workspace {...base} {...cb} tabs={[tab]} hosts={hosts} {...over} />)
  return {...cb, view}
}

describe('Workspace: the header of a pane', () => {
  beforeEach(() => { mounts.length = 0; typedHooks.clear() })

  it('names the host with its pane number and small print', () => {
    const {tab} = two()
    mount(tab)
    const bars = screen.getAllByRole('toolbar')
    expect(bars).toHaveLength(2)
    expect(bars[0]).toHaveTextContent('web-1 (1)')
    expect(bars[1]).toHaveTextContent('web-1 (2)')
    expect(bars[0]).toHaveTextContent('ssh, telnet, root')
  })

  it('a single pane has no header at all: it would only cover the first line of the terminal', () => {
    const solo = {...newTab('h1', 'web'), id: 't'}
    mount(solo)
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('describes this computer, serial ports and Telnet panes', () => {
    const split = (hostId: string) => splitPane({...newTab(hostId, 'a'), id: 't'}, newTab(hostId, 'x').activePane, 'row')
    const show = (hostId: string) => {
      let t = {...newTab(hostId, 'a'), id: 't'}
      t = splitPane(t, t.activePane, 'row')
      return render(<Workspace {...base} onFocusPane={vi.fn()} onPaneExit={vi.fn()} onClosePane={vi.fn()} tabs={[t]} hosts={hosts} />)
    }
    void split
    let view = show('local')
    expect(screen.getAllByRole('toolbar')[0]).toHaveTextContent('This computer (1)')
    expect(screen.getAllByRole('toolbar')[0]).toHaveTextContent('local shell')
    view.unmount()
    view = show('serial:/dev/cu.usbserial-1@9600')
    expect(screen.getAllByRole('toolbar')[0]).toHaveTextContent('cu.usbserial-1 (1)')
    expect(screen.getAllByRole('toolbar')[0]).toHaveTextContent('serial')
    view.unmount()
    show('telnet:h1')
    expect(screen.getAllByRole('toolbar')[0]).toHaveTextContent('web-1 (1)')
    expect(screen.getAllByRole('toolbar')[0]).toHaveTextContent('telnet, root')
  })

  it('the buttons call back with the tab and the pane', async () => {
    const {tab, ids} = two()
    const cb = mount(tab)
    const first = screen.getAllByRole('toolbar')[0]
    await userEvent.click(within(first).getByRole('button', {name: 'Broadcast input'}))
    expect(cb.onToggleBroadcast).toHaveBeenCalledWith('t')
    await userEvent.click(within(first).getByRole('button', {name: 'Maximize pane'}))
    expect(cb.onToggleZoom).toHaveBeenCalledWith('t', ids[0])
    await userEvent.click(within(first).getByRole('button', {name: 'Close pane'}))
    expect(cb.onClosePane).toHaveBeenCalledWith('t', ids[0])
    expect(within(first).getByRole('button', {name: 'Broadcast input'})).toHaveAttribute('title', expect.stringContaining('Ctrl+Alt+B'))
  })

  it('while broadcasting the panes are marked and the buttons say so', () => {
    const {tab} = two()
    mount(toggleBroadcast(tab))
    expect(document.querySelectorAll('.pane-wrap.broadcasting')).toHaveLength(2)
    expect(screen.getAllByRole('button', {name: 'Broadcast input'})[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('what is typed in one pane is typed in the others, only while broadcasting', () => {
    const {tab, ids} = two()
    const got: Record<string, string[]> = {[ids[0]]: [], [ids[1]]: []}
    for (const id of ids) registerPane(id, t => { got[id].push(t); return true })
    const {view} = mount(tab)
    expect(typedHooks.get(ids[0])).toBeUndefined() // not broadcasting: nothing is sent anywhere
    view.rerender(<Workspace {...base} onFocusPane={vi.fn()} onPaneExit={vi.fn()} onClosePane={vi.fn()} tabs={[toggleBroadcast(tab)]} hosts={hosts} />)
    typedHooks.get(ids[0])!('ls\r')
    expect(got[ids[1]]).toEqual(['ls\r'])
    expect(got[ids[0]]).toEqual([]) // never echoed back into the pane it came from
  })

  it('zoom shows one pane and hides the others without unmounting any (no session ends)', () => {
    const {tab, ids} = two()
    const {view} = mount(tab)
    expect(mounts.filter(m => m.startsWith('unmount'))).toEqual([])
    view.rerender(<Workspace {...base} onFocusPane={vi.fn()} onPaneExit={vi.fn()} onClosePane={vi.fn()} tabs={[toggleZoom(tab, ids[0])]} hosts={hosts} />)
    expect(document.querySelector(`[data-pane="${ids[0]}"]`)).not.toHaveStyle({display: 'none'})
    expect(document.querySelector(`[data-pane="${ids[1]}"]`)).toHaveStyle({display: 'none'})
    expect(screen.getByTestId('term-' + ids[0])).toHaveAttribute('data-visible', 'true')
    expect(screen.getByTestId('term-' + ids[1])).toHaveAttribute('data-visible', 'false')
    expect(screen.getByRole('button', {name: 'Show all panes'})).toBeInTheDocument()
    expect(mounts.filter(m => m.startsWith('unmount'))).toEqual([]) // still running behind
    view.rerender(<Workspace {...base} onFocusPane={vi.fn()} onPaneExit={vi.fn()} onClosePane={vi.fn()} tabs={[tab]} hosts={hosts} />)
    expect(document.querySelector(`[data-pane="${ids[1]}"]`)).not.toHaveStyle({display: 'none'})
    expect(mounts.filter(m => m.startsWith('unmount'))).toEqual([])
  })

  it('works through a nested split too', () => {
    const {tab, ids} = two()
    const three = splitPane(tab, ids[1], 'col')
    const [a, b, c] = leaves(three.root).map(l => l.id)
    render(<Workspace {...base} onFocusPane={vi.fn()} onPaneExit={vi.fn()} onClosePane={vi.fn()} tabs={[toggleZoom(three, c)]} hosts={hosts} />)
    for (const id of [a, b]) expect(document.querySelector(`[data-pane="${id}"]`)).toHaveStyle({display: 'none'})
    expect(document.querySelector(`[data-pane="${c}"]`)).not.toHaveStyle({display: 'none'})
    expect(fireEvent).toBeDefined()
  })
})
