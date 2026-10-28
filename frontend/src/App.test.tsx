import {act, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {host, makeFake, Providers} from './test/fakeBackend'

vi.mock('./lib/terminal/TerminalPane', () => ({
  TerminalPane: (p: {hostId: string; onExit(): void}) => <div data-testid="terminal" data-host={p.hostId}><button onClick={p.onExit}>exit-{p.hostId}</button></div>,
}))

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

describe('App', () => {
  it('starts on the unlock screen and shows hosts after unlocking', async () => {
    const be = setup()
    expect(await screen.findByRole('form', {name: 'Unlock vault'})).toBeInTheDocument()
    expect(screen.queryByText('web-1')).toBeNull()
    await unlock(be)
    expect(screen.getByText('web-1')).toBeInTheDocument()
    expect(screen.getByText('No open terminals')).toBeInTheDocument()
  })

  it('shows the create-vault flow on first run', async () => {
    setup({vault: {exists: false, unlocked: false, keychain_enabled: false, auto_lock_minutes: 15}})
    expect(await screen.findByRole('form', {name: 'Create vault'})).toBeInTheDocument()
  })

  it('opens a tab per double-click, switches and closes tabs', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(screen.getByText('web-1'))
    await userEvent.dblClick(screen.getByText('db-1'))
    expect(screen.getAllByTestId('terminal')).toHaveLength(2)
    expect(screen.getAllByRole('tab', {selected: true})).toHaveLength(1)
    await userEvent.click(screen.getAllByRole('tab')[0])
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByLabelText('Close web-1'))
    expect(screen.getAllByTestId('terminal')).toHaveLength(1)
    await userEvent.click(screen.getByLabelText('Close db-1'))
    expect(screen.getByText('No open terminals')).toBeInTheDocument()
  })

  it('splits the active pane right and down', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(screen.getByText('web-1'))
    await userEvent.click(screen.getByLabelText('Split right'))
    expect(screen.getAllByTestId('terminal')).toHaveLength(2)
    await userEvent.click(screen.getByLabelText('Split down'))
    expect(screen.getAllByTestId('terminal')).toHaveLength(3)
    expect(screen.getAllByTestId('terminal').every(t => t.getAttribute('data-host') === 'h1')).toBe(true)
  })

  it('removes a pane when its shell exits and the tab when the last pane exits', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.dblClick(screen.getByText('web-1'))
    await userEvent.click(screen.getByLabelText('Split right'))
    await userEvent.click(screen.getAllByText('exit-h1')[0])
    expect(screen.getAllByTestId('terminal')).toHaveLength(1)
    await userEvent.click(screen.getByText('exit-h1'))
    expect(screen.queryAllByTestId('terminal')).toHaveLength(0)
    expect(screen.getByText('No open terminals')).toBeInTheDocument()
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
    await userEvent.click(screen.getByRole('button', {name: /Lock/}))
    expect(await screen.findByRole('form', {name: 'Unlock vault'})).toBeInTheDocument()
  })

  it('creates a host through the form', async () => {
    const be = setup({hosts: []})
    await unlock(be)
    await userEvent.click(screen.getByLabelText('New host'))
    await userEvent.type(screen.getByLabelText('Hostname'), 'new.example.com')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByText('new.example.com')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('deletes a host after confirmation', async () => {
    const be = setup()
    await unlock(be)
    await userEvent.click(screen.getByLabelText('Delete web-1'))
    await waitFor(() => expect(screen.queryByText('web-1')).toBeNull())
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
    for (const [btn, title] of [[/Vault/, 'Vault · Identities'], [/Data/, 'Import & export'], [/Sync/, 'Sync via Git'], [/Settings/, 'Settings']] as const) {
      await userEvent.click(screen.getByRole('button', {name: btn}))
      expect(await screen.findByRole('dialog', {name: title})).toBeInTheDocument()
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
  })

  it('applies the theme from settings', async () => {
    const be = setup({settings: {theme: 'light', font_size: 13, font_family: 'monospace', auto_lock_minutes: 15, sync_url: ''}})
    await unlock(be)
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
  })
})
