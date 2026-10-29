import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {KnownHostsPage} from './KnownHostsPage'
import {LOG_GROUPS, LogsPage, formatWhen} from './LogsPage'
import {makeFake, Providers} from '../../test/fakeBackend'
import type {ActivityEntry, KnownHost} from '../types'

const kh = (host: string, fp = 'SHA256:' + host): KnownHost => ({host, key_type: 'ssh-ed25519', fingerprint: fp})
const log = (id: number, kind: ActivityEntry['kind'], message: string, over: Partial<ActivityEntry> = {}): ActivityEntry => ({id, at: '2026-10-28T14:32:10Z', kind, message, ok: true, ...over})

describe('Known Hosts page', () => {
  const mount = (hosts: KnownHost[]) => {
    const be = makeFake({knownHosts: hosts})
    render(<Providers be={be}><KnownHostsPage /></Providers>)
    return be
  }

  it('lists the trusted hosts with key type and fingerprint', async () => {
    mount([kh('web.example.com'), kh('[10.0.0.5]:2222')])
    const cards = await screen.findAllByRole('listitem')
    expect(cards.map(c => c.querySelector('.label')?.textContent)).toEqual(['web.example.com', '[10.0.0.5]:2222'])
    expect(cards[0].querySelector('.addr')).toHaveTextContent('ssh-ed25519 · SHA256:web.example.com')
  })

  it('says what this page is when nothing is trusted yet', async () => {
    mount([])
    expect(await screen.findByText(/No trusted hosts yet/)).toBeInTheDocument()
  })

  it('searches by host, key type and fingerprint', async () => {
    mount([kh('web.example.com'), kh('db.internal')])
    await screen.findByText('web.example.com')
    await userEvent.type(screen.getByLabelText('Search known hosts'), 'internal')
    expect(screen.queryByText('web.example.com')).toBeNull()
    expect(screen.getByText('db.internal')).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('Search known hosts'))
    await userEvent.type(screen.getByLabelText('Search known hosts'), 'zzz')
    expect(screen.getByText('No host matches.')).toBeInTheDocument()
  })

  it('forgets a host after confirming, and explains what that means', async () => {
    const be = mount([kh('web.example.com'), kh('db.internal')])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
    await userEvent.click(await screen.findByRole('button', {name: 'Forget web.example.com'}))
    expect(be.state.knownHosts).toHaveLength(2)
    expect(confirm.mock.calls[0][0]).toMatch(/ask whether to trust its key again/)
    await userEvent.click(screen.getByRole('button', {name: 'Forget web.example.com'}))
    await waitFor(() => expect(screen.queryByText('web.example.com')).toBeNull())
    expect(be.state.calls).toContainEqual(['knownHosts.forget', 'web.example.com', 'SHA256:web.example.com'])
    expect(screen.getByText('db.internal')).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('copies a fingerprint', async () => {
    mount([kh('web.example.com')])
    const write = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: write}, configurable: true})
    await userEvent.click(await screen.findByRole('button', {name: 'Copy fingerprint of web.example.com'}))
    expect(write).toHaveBeenCalledWith('SHA256:web.example.com')
  })

  it('hashed entries are shown but cannot be forgotten, with the reason', async () => {
    mount([kh('(hashed)', 'SHA256:abc')])
    expect(await screen.findByRole('button', {name: 'Forget (hashed)'})).toBeDisabled()
    expect(screen.getByText(/cannot be named, so they cannot be forgotten here/)).toBeInTheDocument()
  })

  it('refreshes when something new was trusted (log:added), and shows a backend error', async () => {
    const be = mount([])
    await screen.findByText(/No trusted hosts yet/)
    be.state.knownHosts = [kh('new.example.com')]
    act(() => be.emit('log:added'))
    expect(await screen.findByText('new.example.com')).toBeInTheDocument()
    be.knownHosts.list = async () => { throw 'permission denied' }
    await userEvent.click(screen.getByRole('button', {name: 'Refresh known hosts'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
  })
})

describe('Logs page', () => {
  const entries = [
    log(5, 'transfer', 'Uploaded 3 files and 1 folder (1.2 KB) to /srv', {host_label: 'web'}),
    log(4, 'disconnect', 'Connection lost: eof', {host_label: 'web', ok: false}),
    log(3, 'connect', 'Connected to 10.0.0.1:22', {host_label: 'web'}),
    log(2, 'vault', 'Unlock failed', {ok: false}),
    log(1, 'sync', 'Synced with the repository'),
  ]
  const mount = (logs = entries) => {
    const be = makeFake({logs})
    render(<Providers be={be}><LogsPage /></Providers>)
    return be
  }
  const rows = () => within(screen.getByRole('table', {name: 'Activity'})).queryAllByRole('row')

  it('shows the newest lines first with host, message and whether it worked', async () => {
    mount()
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(rows()[0]).toHaveTextContent('web')
    expect(rows()[0]).toHaveTextContent('Uploaded 3 files and 1 folder')
    expect(rows()[1]).toHaveClass('bad')
    expect(within(rows()[1]).getByLabelText('failed')).toBeInTheDocument()
    expect(within(rows()[0]).getByLabelText('ok')).toBeInTheDocument()
  })

  it('filters by group and by text, asking the backend', async () => {
    const be = mount()
    await waitFor(() => expect(rows()).toHaveLength(5))
    await userEvent.click(screen.getByRole('button', {name: 'Connections'}))
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(screen.getByRole('button', {name: 'Connections'})).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', {name: 'Security'}))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toHaveTextContent('Unlock failed')
    await userEvent.click(screen.getByRole('button', {name: 'All'}))
    await userEvent.type(screen.getByLabelText('Search logs'), 'lost')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toHaveTextContent('Connection lost')
    const last = be.state.calls.filter(c => c[0] === 'logs.list').at(-1)![1] as {kinds: string[]; query: string; limit: number}
    expect(last).toEqual({kinds: [], query: 'lost', limit: 500})
  })

  it('says what to expect when empty, and when nothing matches', async () => {
    mount([])
    expect(await screen.findByText(/Nothing has happened yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Clear logs'})).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Search logs'), 'x')
    expect(await screen.findByText('Nothing matches.')).toBeInTheDocument()
  })

  it('updates live when a line is added', async () => {
    const be = mount([entries[2]])
    await waitFor(() => expect(rows()).toHaveLength(1))
    be.state.logs = [log(9, 'forward', 'Started local forward "SQL"', {host_label: 'db'}), ...be.state.logs]
    act(() => be.emit('log:added'))
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]).toHaveTextContent('Started local forward "SQL"')
  })

  it('clears after confirming', async () => {
    const be = mount()
    await waitFor(() => expect(rows()).toHaveLength(5))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', {name: 'Clear logs'}))
    expect(be.state.logs).toHaveLength(5)
    await userEvent.click(screen.getByRole('button', {name: 'Clear logs'}))
    await waitFor(() => expect(be.state.logs).toHaveLength(0))
    expect(await screen.findByText(/Nothing has happened yet/)).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('shows a backend error', async () => {
    const be = makeFake()
    be.logs.list = async () => { throw 'database is locked' }
    render(<Providers be={be}><LogsPage /></Providers>)
    expect(await screen.findByRole('alert')).toHaveTextContent('database is locked')
  })

  it('formats the time without the year this year, and with it otherwise', () => {
    const now = new Date('2026-10-28T12:00:00Z')
    expect(formatWhen('2026-03-05T09:08:07Z', now)).not.toMatch(/2026/)
    expect(formatWhen('2025-03-05T09:08:07Z', now)).toMatch(/2025/)
    expect(formatWhen('garbage', now)).toBe('')
    expect(LOG_GROUPS.map(g => g.id)).toEqual(['all', 'connections', 'files', 'forwards', 'security', 'sync', 'assistant'])
  })
})
