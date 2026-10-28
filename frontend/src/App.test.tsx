import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {host, makeFake, Providers} from './test/fakeBackend'
import {DEFAULT_SETTINGS} from './lib/settings/defaults'

const typed = vi.hoisted(() => ({text: [] as string[], ready: true}))
vi.mock('./lib/terminal/TerminalPane', async () => {
  const {useEffect} = await import('react')
  const {registerPane} = await import('./lib/terminal/panes')
  return {
    TerminalPane: (p: {hostId: string; paneId?: string; onExit(): void}) => {
      useEffect(() => (p.paneId ? registerPane(p.paneId, t => { if (!typed.ready) return false; typed.text.push(t); return true }) : undefined), [p.paneId])
      return <div data-testid="terminal" data-host={p.hostId}><button onClick={p.onExit}>exit-{p.hostId}</button></div>
    },
  }
})

import App from './App'

function setup(extra: Parameters<typeof makeFake>[0] = {}) {
  const be = makeFake({hosts: [host({id: 'h1', label: 'web-1'}), host({id: 'h2', label: 'db-1'})], ...extra})
  render(<Providers be={be}><App /></Providers>)
  return be
}

async function unlock(be: ReturnType<typeof makeFake>) {
  await userEvent.type(await screen.findByLabelText('Master password'), be.state.password)
  await userEvent.click(screen.getByRole('button', {name: 'Unlock'}))
  await screen.findByRole('list', {name: 'Hosts'})
}

const hostCard = (name: string) => screen.getByText(name, {selector: '.label'})

describe('App', () => {
  it('starts on the unlock screen and shows hosts after unlocking', async () => {
    const be = setup()
    expect(await screen.findByRole('form', {name: 'Unlock vault'})).toBeInTheDocument()
    expect(screen.queryByText('web-1')).toBeNull()
    await unlock(be)
    expect(hostCard('web-1')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Find a host or ssh user@hostname/)).toBeInTheDocument()
    expect(screen.getByRole('tab', {name: 'Vaults', selected: true})).toBeInTheDocument()
  })

  it('shows the create-vault flow on first run', async () => {
    setup({vault: {exists: false, unlocked: false, keychain_enabled: false, auto_lock_minutes: 15}})
    expect(await screen.findByRole('form', {name: 'Create vault'})).toBeInTheDocument()
  })

  it('opens a tab per double-click, switches and closes tabs', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.dblClick(hostCard('db-1'))
    expect(screen.getAllByTestId('terminal')).toHaveLength(2)
    expect(screen.getAllByRole('tab', {selected: true})).toHaveLength(1)
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('db-1') // newest tab is active
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    expect(screen.getByRole('tab', {name: 'Vaults'})).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByTestId('terminal')).toHaveLength(2) // sessions keep running behind the home tab
    await userEvent.click(screen.getByLabelText('Close web-1'))
    expect(screen.getAllByTestId('terminal')).toHaveLength(1)
    await userEvent.click(screen.getByLabelText('Close db-1'))
    expect(screen.queryAllByTestId('terminal')).toHaveLength(0)
    expect(screen.getByRole('tab', {name: 'Vaults', selected: true})).toBeInTheDocument()
  })

  it('splits the active pane right and down', async () => {
    const be = setup()
    await unlock(be)
    expect(screen.getByLabelText('Split right')).toBeDisabled() // only meaningful inside a terminal tab
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByLabelText('Split right'))
    expect(screen.getAllByTestId('terminal')).toHaveLength(2)
    await userEvent.click(screen.getByLabelText('Split down'))
    expect(screen.getAllByTestId('terminal')).toHaveLength(3)
    expect(screen.getAllByTestId('terminal').every(t => t.getAttribute('data-host') === 'h1')).toBe(true)
  })

  it('removes a pane when its shell exits and the tab when the last pane exits', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByLabelText('Split right'))
    await userEvent.click(screen.getAllByText('exit-h1')[0])
    expect(screen.getAllByTestId('terminal')).toHaveLength(1)
    await userEvent.click(screen.getByText('exit-h1'))
    expect(screen.queryAllByTestId('terminal')).toHaveLength(0)
    expect(screen.getByRole('tab', {name: 'Vaults', selected: true})).toBeInTheDocument()
  })

  it('returns to the unlock screen when the vault auto-locks', async () => {
    const be = setup()
    await unlock(be)
    be.state.vault = {...be.state.vault, unlocked: false}
    act(() => be.emit('vault:locked'))
    expect(await screen.findByRole('form', {name: 'Unlock vault'})).toBeInTheDocument()
  })

  it('the Lock button locks the vault', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: /Lock vault/}))
    expect(await screen.findByRole('form', {name: 'Unlock vault'})).toBeInTheDocument()
  })

  it('creates a host through the form', async () => {
    const be = setup({hosts: []})
    await unlock(be)
    await userEvent.click(screen.getByLabelText('New host'))
    await userEvent.type(screen.getByLabelText('Hostname'), 'new.example.com')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByText('new.example.com', {selector: '.label'})).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('deletes a host after confirmation', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByLabelText('Delete web-1'))
    await waitFor(() => expect(screen.queryByText('web-1', {selector: '.label'})).toBeNull())
    expect(be.state.hosts.map(h => h.id)).toEqual(['h2'])
  })

  it('does not delete when the confirmation is declined', async () => {
    const be = setup()
    await unlock(be)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await userEvent.click(screen.getByLabelText('Delete web-1'))
    expect(be.state.hosts).toHaveLength(2)
  })

  it('opens each panel from the sidebar and closes with Escape', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: /Import \/ Export/}))
    expect(await screen.findByRole('dialog', {name: 'Import & export'})).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('applies the theme from settings', async () => {
    const be = setup({settings: {...DEFAULT_SETTINGS, theme: 'light'}})
    await unlock(be)
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
  })
})

describe('App navigation and quick connect', () => {
  it('switches between Hosts, Keychain and Port Forwarding pages', async () => {
    const be = setup({forwards: [{id: 'f1', host_id: 'h1', type: 'dynamic', bind_addr: '127.0.0.1', bind_port: 1080, auto_start: false}]})
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Keychain'}))
    expect(screen.getByRole('heading', {name: 'Keys'})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Keychain'})).toHaveAttribute('aria-current', 'page')
    await userEvent.click(screen.getByRole('button', {name: 'Port Forwarding'}))
    expect(await screen.findByText(/SOCKS5 127\.0\.0\.1:1080/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Hosts'}))
    expect(hostCard('web-1')).toBeInTheDocument()
  })

  it('a forward card has Edit, which opens the docked panel on the Port Forwarding page', async () => {
    const be = setup({forwards: [{id: 'f1', host_id: 'h1', type: 'dynamic', bind_addr: '127.0.0.1', bind_port: 1080, auto_start: false}]})
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Port Forwarding'}))
    await userEvent.click(await screen.findByRole('button', {name: 'Edit Dynamic Rule'}))
    expect(await screen.findByRole('dialog', {name: 'Edit Port Forwarding'})).toBeInTheDocument()
  })

  it('the Forwards button of a host card opens New Port Forwarding with that host already chosen', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Forwards db-1'}))
    expect(await screen.findByRole('heading', {name: 'Port Forwarding'})).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', {name: 'Skip wizard'}))
    expect(screen.getByRole('combobox', {name: /^Host, db-1/})).toBeInTheDocument()
  })

  it('quick connect to an unknown host opens the New host panel prefilled', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.type(screen.getByLabelText('Search hosts'), 'ssh deploy@new.example.org:2200{Enter}')
    expect(await screen.findByRole('dialog', {name: 'New host'})).toBeInTheDocument()
    expect(screen.getByLabelText('Hostname')).toHaveValue('new.example.org')
    expect(screen.getByLabelText('Port')).toHaveValue('2200')
    expect(screen.getByLabelText('Username')).toHaveValue('deploy')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(be.state.hosts.some(h => h.hostname === 'new.example.org' && h.port === 2200)).toBe(true))
    // the draft must be created as a new record, not overwrite an existing one
    expect(be.state.hosts).toHaveLength(3)
  })

  it('the + tab returns home and focuses the search box', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByLabelText('New connection'))
    expect(screen.getByRole('tab', {name: 'Vaults', selected: true})).toBeInTheDocument()
  })
})

describe('App snippets', () => {
  beforeEach(() => { typed.text.length = 0; typed.ready = true })
  const snip = {id: 'sn1', label: 'Disk', script: 'df -h\nuptime'}

  it('creates a snippet from the Snippets page', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Snippets'}))
    await userEvent.click(screen.getByRole('button', {name: 'New snippet'}))
    await userEvent.type(screen.getByLabelText('Snippet label'), 'Uptime')
    await userEvent.type(screen.getByLabelText('Script'), 'uptime')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByText('Uptime')).toBeInTheDocument()
    expect(be.state.snippets).toHaveLength(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Run types the script and Enter into the focused pane of the last terminal and switches to it', async () => {
    const be = setup({snippets: [snip]})
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.click(screen.getByRole('button', {name: 'Snippets'}))
    await userEvent.click(await screen.findByLabelText('Run Disk'))
    expect(typed.text).toEqual(['df -h\ruptime\r'])
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('web-1')
  })

  it('Paste does not press Enter', async () => {
    const be = setup({snippets: [snip]})
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.click(screen.getByRole('button', {name: 'Snippets'}))
    await userEvent.click(await screen.findByLabelText('Paste Disk'))
    expect(typed.text).toEqual(['df -h\ruptime'])
  })

  it('refuses to run without an open terminal', async () => {
    const be = setup({snippets: [snip]})
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Snippets'}))
    await userEvent.click(await screen.findByLabelText('Run Disk'))
    expect(await screen.findByRole('status')).toHaveTextContent('Open a terminal first')
    expect(typed.text).toEqual([])
  })

  it('reports a terminal that is not connected yet', async () => {
    const be = setup({snippets: [snip]})
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    typed.ready = false
    await userEvent.click(screen.getByRole('button', {name: 'Run snippet'}))
    await userEvent.click(await screen.findByRole('menuitem', {name: /Disk/}).then(el => el.querySelector('button')!))
    expect(await screen.findByRole('status')).toHaveTextContent('not connected')
  })

  it('the title-bar picker runs a snippet inside the terminal view', async () => {
    const be = setup({snippets: [snip]})
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByRole('button', {name: 'Run snippet'}))
    await userEvent.click(screen.getByRole('menuitem', {name: /Disk/}).querySelector('button')!)
    expect(typed.text).toEqual(['df -h\ruptime\r'])
  })

  it('deletes after confirmation', async () => {
    const be = setup({snippets: [snip]})
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Snippets'}))
    await userEvent.click(await screen.findByLabelText('Delete Disk'))
    await waitFor(() => expect(be.state.snippets).toHaveLength(0))
  })
})

describe('App: docked panels, connect from the form, settings page, theme', () => {
  it('New host opens next to the list (same screen) and shows a draft card that follows typing', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByLabelText('New host'))
    const panel = await screen.findByRole('dialog', {name: 'New host'})
    expect(panel.tagName).toBe('ASIDE')
    expect(document.querySelector('.modal-back')).toBeNull()
    expect(screen.getByRole('list', {name: 'Hosts'})).toBeInTheDocument() // the list stays visible
    expect(screen.getByTestId('draft-card')).toHaveTextContent('Enter IP or Hostname…')
    await userEvent.type(screen.getByLabelText('Hostname'), 'typing.example')
    expect(screen.getByTestId('draft-card')).toHaveTextContent('typing.example')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByTestId('draft-card')).toBeNull()
  })

  it('Connect in the New host panel saves the host and opens a terminal tab', async () => {
    const be = setup({hosts: []})
    await unlock(be)
    await userEvent.click(screen.getByLabelText('New host'))
    await userEvent.type(screen.getByLabelText('Hostname'), 'web.example')
    await userEvent.click(within(screen.getByRole('dialog', {name: 'New host'})).getByRole('button', {name: 'Connect'}))
    await waitFor(() => expect(screen.getAllByTestId('terminal')).toHaveLength(1))
    expect(be.state.hosts.map(h => h.hostname)).toEqual(['web.example'])
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('web.example')
  })

  it('Settings opens as its own window above the page, and closes again', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Settings'}))
    const win = await screen.findByRole('dialog', {name: 'Settings'})
    expect(win.closest('.win-back')).not.toBeNull()
    expect(screen.getByRole('tab', {name: 'Terminal'})).toBeInTheDocument()
    expect(screen.getByRole('list', {name: 'Hosts'})).toBeInTheDocument() // the page stays behind it
    expect(screen.queryByRole('button', {name: /^Sync$/})).toBeNull() // Sync is inside the window
    await userEvent.click(screen.getByRole('button', {name: 'Close settings'}))
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Settings'})).toBeNull())
  })

  it('Cmd/Ctrl+, toggles the Settings window from anywhere, including a terminal tab', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.keyboard('{Control>},{/Control}')
    expect(await screen.findByRole('dialog', {name: 'Settings'})).toBeInTheDocument()
    await userEvent.keyboard('{Control>},{/Control}')
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Settings'})).toBeNull())
  })

  it('the gear button in the title bar opens Settings', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Open settings'}))
    expect(await screen.findByRole('dialog', {name: 'Settings'})).toBeInTheDocument()
  })

  it('a terminal theme chosen in Settings is applied to the terminals', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Settings'}))
    await userEvent.click(await screen.findByRole('tab', {name: 'Terminal'}))
    await userEvent.click(await screen.findByRole('radio', {name: 'Dracula'}))
    await waitFor(() => expect(be.state.settings.terminal_theme).toBe('dracula'))
    expect(screen.getByTestId('term-preview')).toHaveStyle({background: '#282a36'})
  })

  it('theme Auto follows the OS appearance', async () => {
    const be = setup({settings: {...DEFAULT_SETTINGS, theme: 'auto'}})
    ;(globalThis as any).setSystemDark(false)
    await unlock(be)
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    act(() => (globalThis as any).setSystemDark(true))
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
  })

  it('after a vault reset the unlock screen becomes the create form', async () => {
    const be = setup()
    await userEvent.click(await screen.findByRole('button', {name: 'Forgot password?'}))
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'RESET')
    await userEvent.click(screen.getByRole('button', {name: 'Erase vault and start over'}))
    expect(await screen.findByRole('form', {name: 'Create vault'})).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('old vault was erased')
    void be
  })
})

describe('App: panels belong to the page they were opened on', () => {
  const panelOpen = (name: string) => screen.queryByRole('dialog', {name})

  it('New host closes when you move to another screen', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByLabelText('New host'))
    expect(await screen.findByRole('dialog', {name: 'New host'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Keychain'}))
    expect(panelOpen('New host')).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: 'Hosts'}))
    expect(panelOpen('New host')).toBeNull() // and it does not come back
    expect(screen.queryByTestId('draft-card')).toBeNull()
  })

  it('New group and New snippet close on page change too', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByLabelText('New group'))
    expect(await screen.findByRole('dialog', {name: 'New group'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Snippets'}))
    expect(panelOpen('New group')).toBeNull()
    await userEvent.click(screen.getByLabelText('New snippet'))
    expect(await screen.findByRole('dialog', {name: 'New snippet'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Port Forwarding'}))
    expect(panelOpen('New snippet')).toBeNull()
  })

  it('opening a terminal closes the panel instead of leaving it behind', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByLabelText('New host'))
    expect(await screen.findByRole('dialog', {name: 'New host'})).toBeInTheDocument()
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    expect(panelOpen('New host')).toBeNull()
  })

  it('staying on the same page keeps the panel (the + tab does not discard typed work)', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByLabelText('New host'))
    await userEvent.type(screen.getByLabelText('Hostname'), 'keep.me')
    await userEvent.click(screen.getByLabelText('New connection'))
    expect(screen.getByLabelText('Hostname')).toHaveValue('keep.me')
  })
})

describe('App: the SFTP tab next to Vaults', () => {
  it('is there from the start, right after Vaults, with no close button, and starts on "Connect to host"', async () => {
    const be = setup()
    await unlock(be)
    const tabs = screen.getAllByRole('tab').map(t => t.textContent?.trim())
    expect(tabs.slice(0, 2)).toEqual(['Vaults', 'SFTP'])
    expect(screen.queryByRole('button', {name: /^Close SFTP/})).toBeNull()
    await userEvent.click(screen.getByRole('tab', {name: 'SFTP'}))
    expect(await screen.findByTestId('sftp')).toHaveAttribute('aria-label', 'SFTP')
    expect(screen.getByText('Connect to host')).toBeInTheDocument()
    expect(screen.getByRole('region', {name: 'Local'})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Split right'})).toBeDisabled()
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.click(screen.getByRole('tab', {name: 'SFTP'}))
    expect(screen.getAllByTestId('sftp')).toHaveLength(1) // the same tab, not another one
  })

  it('the SFTP button of a host card switches to that tab and connects it to the host', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'SFTP web-1'}))
    expect(await screen.findByTestId('sftp')).toHaveAttribute('aria-label', 'SFTP web-1')
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('SFTP')
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'sftp.open' && c[1] === 'h1')).toBe(true))
    // asking again for another host reconnects the same tab
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.click(screen.getByRole('button', {name: 'SFTP db-1'}))
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'sftp.open' && c[1] === 'h2')).toBe(true))
    expect(screen.getAllByTestId('sftp')).toHaveLength(1)
  })

  it('asking for the same host again after "Change host" connects again', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'SFTP web-1'}))
    const pane = await screen.findByRole('region', {name: 'Remote'})
    await userEvent.click(await within(pane).findByRole('button', {name: 'Change host'}))
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.click(screen.getByRole('button', {name: 'SFTP web-1'}))
    await waitFor(() => expect(be.state.calls.filter(c => c[0] === 'sftp.open')).toHaveLength(2))
  })

  it('closing the last terminal goes back to Vaults, not to the SFTP tab; Ctrl+W on the SFTP tab does nothing', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByRole('button', {name: /^Close web-1/}))
    await waitFor(() => expect(screen.queryAllByTestId('terminal')).toHaveLength(0))
    expect(screen.getByRole('tab', {name: 'Vaults', selected: true})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', {name: 'SFTP'}))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', {key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true})) })
    expect(screen.getByRole('tab', {name: 'SFTP', selected: true})).toBeInTheDocument()
  })

  it('snippets still go to the last terminal, never to the SFTP tab', async () => {
    typed.text.length = 0
    typed.ready = true
    const be = setup({snippets: [{id: 'sn1', label: 'Disk', script: 'df -h'}]})
    await unlock(be)
    await userEvent.dblClick(hostCard('db-1'))
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.click(screen.getByRole('button', {name: 'SFTP web-1'}))
    await screen.findByTestId('sftp')
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.click(screen.getByRole('button', {name: 'Snippets'}))
    await userEvent.click(await screen.findByLabelText('Run Disk'))
    expect(typed.text).toEqual(['df -h\r'])
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('db-1')
  })
})

describe('App: keyboard shortcuts', () => {
  const press = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})) })

  it('the default combo opens and closes Settings', async () => {
    const be = setup()
    await unlock(be)
    press({key: ',', code: 'Comma', ctrlKey: true})
    expect(await screen.findByRole('dialog', {name: 'Settings'})).toBeInTheDocument()
    press({key: ',', code: 'Comma', ctrlKey: true})
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Settings'})).toBeNull())
  })

  it('a customised combo works and the old one no longer does', async () => {
    const be = setup({settings: {...DEFAULT_SETTINGS, font_family: 'monospace', shortcuts: {open_settings: 'Alt+S'}}})
    await unlock(be)
    press({key: ',', code: 'Comma', ctrlKey: true})
    expect(screen.queryByRole('dialog', {name: 'Settings'})).toBeNull()
    press({key: 's', code: 'KeyS', altKey: true})
    expect(await screen.findByRole('dialog', {name: 'Settings'})).toBeInTheDocument()
  })

  it('lock vault returns to the unlock screen', async () => {
    const be = setup()
    await unlock(be)
    press({key: 'l', code: 'KeyL', ctrlKey: true})
    expect(await screen.findByRole('form', {name: 'Unlock vault'})).toBeInTheDocument()
  })

  it('zoom shortcuts change and reset the interface zoom', async () => {
    const be = setup()
    await unlock(be)
    press({key: '=', code: 'Equal', ctrlKey: true})
    await waitFor(() => expect(be.state.settings.zoom).toBe(110))
    press({key: '-', code: 'Minus', ctrlKey: true})
    press({key: '-', code: 'Minus', ctrlKey: true})
    await waitFor(() => expect(be.state.settings.zoom).toBe(90))
    press({key: '0', code: 'Digit0', ctrlKey: true})
    await waitFor(() => expect(be.state.settings.zoom).toBe(100))
  })

  it('next/previous tab cycle through Vaults and the open tabs; close tab asks first', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.dblClick(hostCard('db-1'))
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('db-1')
    press({key: 'Tab', code: 'Tab', ctrlKey: true})
    expect(screen.getByRole('tab', {name: 'Vaults', selected: true})).toBeInTheDocument()
    press({key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true})
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('db-1')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    press({key: 'w', code: 'KeyW', ctrlKey: true})
    await waitFor(() => expect(screen.getAllByTestId('terminal')).toHaveLength(1))
    expect(confirm).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
  })

  it('does nothing while a new shortcut is being recorded', async () => {
    const be = setup()
    await unlock(be)
    const {capture} = await import('./lib/shortcuts/shortcuts')
    capture.active = true
    try {
      press({key: 'l', code: 'KeyL', ctrlKey: true})
      expect(screen.queryByRole('form', {name: 'Unlock vault'})).toBeNull()
    } finally { capture.active = false }
  })
})

describe('App: Settings as a native window', () => {
  it('opens the native window (no in-app window) from the navigation, the gear and the shortcut', async () => {
    const be = setup({nativeSettings: true})
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Settings'}))
    await userEvent.click(screen.getByRole('button', {name: 'Open settings'}))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', {key: ',', code: 'Comma', ctrlKey: true, bubbles: true, cancelable: true})) })
    await waitFor(() => expect(be.state.calls.filter(c => c[0] === 'system.openSettings')).toHaveLength(3))
    expect(screen.queryByRole('dialog', {name: 'Settings'})).toBeNull()
  })

  it('falls back to the in-app window when there is no native window', async () => {
    const be = setup({nativeSettings: false})
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Settings'}))
    expect(await screen.findByRole('dialog', {name: 'Settings'})).toBeInTheDocument()
    expect(be.state.calls.filter(c => c[0] === 'system.openSettings')).toHaveLength(1)
  })

  it('picks up settings saved in the Settings window (zoom, theme)', async () => {
    const be = setup({nativeSettings: true})
    await unlock(be)
    const zoom = vi.spyOn(document.documentElement.style, 'setProperty') // jsdom drops the zoom property itself
    be.state.settings = {...be.state.settings, zoom: 130}
    act(() => be.emit('bridge:changed', 'SettingsService'))
    await waitFor(() => expect(zoom).toHaveBeenCalledWith('zoom', '1.3'))
    zoom.mockRestore()
  })

  it('reloads the data after the Settings window changed the vault or sync', async () => {
    const be = setup({nativeSettings: true})
    await unlock(be)
    expect(screen.queryByText('synced-host', {selector: '.label'})).toBeNull()
    be.state.hosts.push(host({id: 'h9', label: 'synced-host'}))
    act(() => be.emit('bridge:changed', 'SyncService'))
    expect(await screen.findByText('synced-host', {selector: '.label'})).toBeInTheDocument()
  })
})


describe('App: confirmations are in-app dialogs (a desktop webview has no confirm())', () => {
  async function setupWithDialogs(extra: Parameters<typeof makeFake>[0] = {}) {
    const {ConfirmProvider} = await import('./lib/ui/Confirm')
    const be = makeFake({hosts: [host({id: 'h1', label: 'web-1'}), host({id: 'h2', label: 'db-1'})], ...extra})
    render(<Providers be={be}><ConfirmProvider><App /></ConfirmProvider></Providers>)
    return be
  }

  it('closing a terminal tab asks in the app, and Cancel keeps it', async () => {
    const native = vi.spyOn(window, 'confirm')
    const be = await setupWithDialogs()
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByRole('button', {name: /^Close web-1/}))
    const dlg = await screen.findByRole('alertdialog', {name: 'Confirm'})
    expect(dlg).toHaveTextContent('Close "web-1"?')
    await userEvent.click(within(dlg).getByRole('button', {name: 'Cancel'}))
    expect(screen.getAllByTestId('terminal')).toHaveLength(1)
    expect(native).not.toHaveBeenCalled()
  })

  it('closing a terminal tab and deleting a host use the same dialog', async () => {
    const native = vi.spyOn(window, 'confirm')
    const be = await setupWithDialogs()
    await unlock(be)
    await userEvent.dblClick(hostCard('web-1'))
    await userEvent.click(screen.getByRole('button', {name: /^Close web-1/}))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', {name: 'Close tab'}))
    await waitFor(() => expect(screen.queryAllByTestId('terminal')).toHaveLength(0))
    await userEvent.click(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.click(screen.getByRole('button', {name: 'Delete db-1'}))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', {name: 'Delete'}))
    await waitFor(() => expect(be.state.hosts.map(h => h.id)).toEqual(['h1']))
    expect(native).not.toHaveBeenCalled()
  })
})

describe('App: server type', () => {
  it('the icon changes as soon as the first connection reveals the server type', async () => {
    const be = setup()
    await unlock(be)
    const tile = () => hostCard('web-1').closest('.host')!.querySelector('.tile') as HTMLElement
    expect(tile()).not.toHaveAttribute('data-os')
    be.state.hosts[0] = {...be.state.hosts[0], os: 'debian'}
    act(() => be.emit('hosts:changed', 'h1'))
    await waitFor(() => expect(tile()).toHaveAttribute('data-os', 'debian'))
    expect(tile()).toHaveAttribute('title', expect.stringContaining('Debian'))
  })
})

describe('App: Terminal and Serial on the Hosts page', () => {
  it('Terminal opens a tab on this computer', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Terminal'}))
    const term = await screen.findByTestId('terminal')
    expect(term).toHaveAttribute('data-host', 'local')
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('Local')
  })

  it('Serial opens a docked panel, then a tab for the port at that speed', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByRole('button', {name: 'Serial'}))
    const panel = await screen.findByRole('dialog', {name: 'Serial'})
    expect(panel.tagName).toBe('ASIDE')
    await userEvent.selectOptions(await within(panel).findByLabelText('Baud rate'), '9600')
    await userEvent.click(within(panel).getByRole('button', {name: 'Connect'}))
    const term = await screen.findByTestId('terminal')
    expect(term).toHaveAttribute('data-host', 'serial:/dev/cu.usbserial-1410@9600')
    expect(screen.getAllByRole('tab', {selected: true})[0]).toHaveTextContent('cu.usbserial-1410')
    expect(screen.queryByRole('dialog', {name: 'Serial'})).toBeNull()
  })
})

describe('App: Hosts toolbar order', () => {
  it('New host, New group, then Terminal and Serial', async () => {
    const be = setup()
    await unlock(be)
    const bar = document.querySelector('.toolbar') as HTMLElement
    expect(Array.from(bar.querySelectorAll('button')).map(b => b.getAttribute('aria-label'))).toEqual(['New host', 'New group', 'Terminal', 'Serial'])
  })
})
