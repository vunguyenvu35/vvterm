import {render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {TerminalSidebar, FONT_MAX, FONT_MIN} from './Sidebar'
import {clearHistory, recordCommand} from './history'
import {TERMINAL_THEMES} from './themes'
import {DEFAULT_SETTINGS} from '../settings/defaults'
import {host} from '../../test/fakeBackend'
import type {SidebarTab} from './Sidebar'
import type {Snippet} from '../types'

const snippets: Snippet[] = [{id: 's1', label: 'Docker Full clean', script: 'docker stop $(docker ps -aq)'}, {id: 's2', label: 'Disk', script: 'df -h'}]

function setup(tab: SidebarTab, over: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const cb = {onTab: vi.fn(), onInsert: vi.fn(), onNewSnippet: vi.fn(), onConnect: vi.fn(), onSettings: vi.fn()}
  const hosts = [host({id: 'h1', label: 'web-1', hostname: 'w1.example.com'}), host({id: 'h2', label: 'db-1', hostname: 'db.example.com'})]
  render(<TerminalSidebar tab={tab} hosts={hosts} snippets={snippets} settings={{...DEFAULT_SETTINGS, ...over}} appearance="dark" {...cb} />)
  return cb
}

beforeEach(() => clearHistory())

describe('TerminalSidebar', () => {
  it('has the four sections and tells which one is open', async () => {
    const cb = setup('snippets')
    const bar = screen.getByRole('toolbar', {name: 'Sidebar sections'})
    expect(within(bar).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Hosts', 'Snippets', 'History', 'Themes and font'])
    expect(within(bar).getByRole('button', {name: 'Snippets'})).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(within(bar).getByRole('button', {name: 'History'}))
    expect(cb.onTab).toHaveBeenCalledWith('history')
  })

  it('Hosts: searches and opens a host', async () => {
    const cb = setup('hosts')
    await userEvent.type(screen.getByLabelText('Search hosts in the sidebar'), 'db')
    expect(screen.queryByText('web-1')).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: /db-1/}))
    expect(cb.onConnect).toHaveBeenCalledWith(expect.objectContaining({id: 'h2'}))
  })

  it('Snippets: click types it, double-click runs it, New Snippet and search work', async () => {
    const cb = setup('snippets')
    await userEvent.click(screen.getByRole('button', {name: /Disk/}))
    expect(cb.onInsert).toHaveBeenLastCalledWith('df -h', false)
    await userEvent.dblClick(screen.getByRole('button', {name: /Disk/}))
    expect(cb.onInsert).toHaveBeenLastCalledWith('df -h', true)
    await userEvent.click(screen.getByRole('button', {name: 'New Snippet'}))
    expect(cb.onNewSnippet).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', {name: 'Search snippets'}))
    await userEvent.type(screen.getByLabelText('Search snippets in the sidebar'), 'docker')
    expect(screen.queryByRole('button', {name: /Disk/})).toBeNull()
    expect(screen.getByRole('button', {name: /Docker Full clean/})).toBeInTheDocument()
  })

  it('History: lists typed commands, filters, types and clears them', async () => {
    recordCommand('ls -la')
    recordCommand('docker ps')
    const cb = setup('history')
    expect(within(screen.getByRole('list', {name: 'History'})).getAllByRole('button').map(i => i.textContent)).toEqual(['docker ps', 'ls -la'])
    await userEvent.type(screen.getByLabelText('Search history'), 'ls')
    expect(screen.queryByText('docker ps')).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: /ls -la/}))
    expect(cb.onInsert).toHaveBeenCalledWith('ls -la', false)
    await userEvent.clear(screen.getByLabelText('Search history'))
    await userEvent.click(screen.getByRole('button', {name: 'Clear history'}))
    expect(screen.getByText(/Commands you type will show up here/)).toBeInTheDocument()
  })

  it('Themes: lists the themes as pictures, marks the current one and picks another', async () => {
    const cb = setup('themes', {terminal_theme: 'nord'})
    const list = screen.getByRole('listbox', {name: 'Themes'})
    expect(within(list).getAllByRole('option')).toHaveLength(TERMINAL_THEMES.length + 1)
    expect(within(list).getByRole('option', {name: /Nord/})).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(within(list).getByRole('option', {name: /Dracula/}))
    expect(cb.onSettings).toHaveBeenCalledWith({terminal_theme: 'dracula'})
    await userEvent.click(within(list).getByRole('option', {name: /Match app theme/}))
    expect(cb.onSettings).toHaveBeenLastCalledWith({terminal_theme: 'auto'})
  })

  it('Font: family and size, with limits', async () => {
    const cb = setup('themes', {font_size: 14, font_family: 'Source Code Pro'})
    expect(screen.getByLabelText('Font family')).toHaveValue('Source Code Pro')
    expect(screen.getByLabelText('Text size')).toHaveTextContent('14')
    await userEvent.click(screen.getByRole('button', {name: 'Larger text'}))
    expect(cb.onSettings).toHaveBeenLastCalledWith({font_size: 15})
    await userEvent.click(screen.getByRole('button', {name: 'Smaller text'}))
    expect(cb.onSettings).toHaveBeenLastCalledWith({font_size: 13})
    await userEvent.type(screen.getByLabelText('Font family'), 'X')
    expect(cb.onSettings).toHaveBeenLastCalledWith({font_family: 'Source Code ProX'})
  })

  it('Font size stops at the limits', () => {
    setup('themes', {font_size: FONT_MAX})
    expect(screen.getByRole('button', {name: 'Larger text'})).toBeDisabled()
  })
  it('Font size stops at the lower limit too', () => {
    setup('themes', {font_size: FONT_MIN})
    expect(screen.getByRole('button', {name: 'Smaller text'})).toBeDisabled()
  })
})
