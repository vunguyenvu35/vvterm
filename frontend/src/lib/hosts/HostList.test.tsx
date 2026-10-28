import {render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {HostList, parseQuickConnect} from './HostList'
import {host} from '../../test/fakeBackend'
import type {Group} from '../types'

const groups: Group[] = [
  {id: 'g1', name: 'prod-cluster', sort_order: 0},
  {id: 'g2', name: 'edge', parent_id: 'g1', sort_order: 0},
]
const hosts = [
  host({id: 'a', label: 'web-1', hostname: 'w1.example.com', env: 'prod', group_id: 'g1', tags: ['nginx']}),
  host({id: 'e', label: 'cdn-1', hostname: 'cdn.example.com', env: 'prod', group_id: 'g2'}),
  host({id: 'b', label: 'db-1', hostname: 'db.internal', env: 'staging', tags: ['mariadb']}),
  host({id: 'c', label: 'box', hostname: '10.1.1.1', username: 'alice', env: 'dev'}),
]

function setup(over: Partial<React.ComponentProps<typeof HostList>> = {}) {
  const cb = {onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onForwards: vi.fn(), onEditGroup: vi.fn(), onDeleteGroup: vi.fn(), onQuickConnect: vi.fn()}
  render(<HostList groups={groups} hosts={hosts} {...cb} {...over} />)
  return cb
}

const labels = () => within(screen.getByRole('list', {name: 'Hosts'})).queryAllByRole('listitem').map(e => e.querySelector('.label')?.textContent)

describe('HostList', () => {
  it('shows ungrouped hosts and group cards with host counts (including sub-groups)', () => {
    setup()
    expect(labels().sort()).toEqual(['box', 'db-1'])
    const card = screen.getByRole('button', {name: 'Open group prod-cluster'})
    expect(card).toHaveTextContent('2 Hosts')
    expect(screen.queryByRole('button', {name: 'Open group edge'})).toBeNull() // nested, not at the root
  })

  it('drills into a group, shows sub-groups and a breadcrumb, and goes back', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', {name: 'Open group prod-cluster'}))
    expect(labels()).toEqual(['web-1'])
    expect(screen.getByRole('button', {name: 'Open group edge'})).toHaveTextContent('1 Host')
    expect(screen.getByRole('navigation', {name: 'Group path'})).toHaveTextContent('prod-cluster')
    await userEvent.click(screen.getByRole('button', {name: 'Open group edge'}))
    expect(labels()).toEqual(['cdn-1'])
    await userEvent.click(screen.getByRole('button', {name: 'All hosts'}))
    expect(labels().sort()).toEqual(['box', 'db-1'])
  })

  it('searches across all groups by label, hostname, user and tag', async () => {
    setup()
    const box = screen.getByLabelText('Search hosts')
    await userEvent.type(box, 'NGINX')
    expect(labels()).toEqual(['web-1'])
    await userEvent.clear(box)
    await userEvent.type(box, 'alice')
    expect(labels()).toEqual(['box'])
    await userEvent.clear(box)
    await userEvent.type(box, 'zzz')
    expect(screen.getByText('No hosts match.')).toBeInTheDocument()
    expect(screen.queryByText('Groups')).toBeNull() // flat results while filtering
  })

  it('filters by environment and toggles off', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', {name: /^prod$/}))
    expect(labels().sort()).toEqual(['cdn-1', 'web-1'])
    await userEvent.click(screen.getByRole('button', {name: /^prod$/}))
    expect(labels().sort()).toEqual(['box', 'db-1'])
  })

  it('connects on double click and via the hover actions', async () => {
    const cb = setup()
    await userEvent.dblClick(screen.getByText('db-1'))
    expect(cb.onConnect).toHaveBeenCalledWith(hosts[2])
    await userEvent.click(screen.getByLabelText('Edit box'))
    await userEvent.click(screen.getByLabelText('Forwards box'))
    await userEvent.click(screen.getByLabelText('Delete box'))
    await userEvent.click(screen.getByLabelText('Connect box'))
    expect(cb.onEdit).toHaveBeenCalledWith(hosts[3])
    expect(cb.onForwards).toHaveBeenCalledWith(hosts[3])
    expect(cb.onDelete).toHaveBeenCalledWith(hosts[3])
    expect(cb.onConnect).toHaveBeenLastCalledWith(hosts[3])
  })

  it('edits and deletes a group without opening it', async () => {
    const cb = setup()
    await userEvent.click(screen.getByLabelText('Edit group prod-cluster'))
    await userEvent.click(screen.getByLabelText('Delete group prod-cluster'))
    expect(cb.onEditGroup).toHaveBeenCalledWith(groups[0])
    expect(cb.onDeleteGroup).toHaveBeenCalledWith(groups[0])
    expect(screen.queryByRole('navigation', {name: 'Group path'})).toBeNull()
  })

  it('shows an empty-state hint', () => {
    render(<HostList groups={[]} hosts={[]} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onForwards={vi.fn()} onEditGroup={vi.fn()} onDeleteGroup={vi.fn()} />)
    expect(screen.getByText(/No hosts yet/)).toBeInTheDocument()
  })

  it('renders the toolbar slot', () => {
    setup({toolbar: <button>Custom action</button>})
    expect(screen.getByRole('button', {name: 'Custom action'})).toBeInTheDocument()
  })
})

describe('quick connect', () => {
  it('Connect opens the only matching host', async () => {
    const cb = setup()
    await userEvent.type(screen.getByLabelText('Search hosts'), 'ssh alice@10.1.1.1')
    await userEvent.click(screen.getByRole('button', {name: 'Connect'}))
    expect(cb.onConnect).toHaveBeenCalledWith(hosts[3])
    expect(cb.onQuickConnect).not.toHaveBeenCalled()
  })

  it('an unknown target starts a new host with the parsed values (Enter works too)', async () => {
    const cb = setup()
    await userEvent.type(screen.getByLabelText('Search hosts'), 'ssh deploy@new.example.org:2200{Enter}')
    expect(cb.onQuickConnect).toHaveBeenCalledWith({username: 'deploy', hostname: 'new.example.org', port: 2200})
    expect(cb.onConnect).not.toHaveBeenCalled()
  })

  it('Connect is disabled until something is typed', () => {
    setup()
    expect(screen.getByRole('button', {name: 'Connect'})).toBeDisabled()
  })

  it.each([
    ['ssh root@10.0.0.1', {username: 'root', hostname: '10.0.0.1', port: 22}],
    ['host.example.com', {username: '', hostname: 'host.example.com', port: 22}],
    ['u@h:2222', {username: 'u', hostname: 'h', port: 2222}],
    ['SSH   u@h', {username: 'u', hostname: 'h', port: 22}],
  ])('parses %s', (text, want) => expect(parseQuickConnect(text)).toEqual(want))

  it.each(['', 'a b c', 'h:99999', '@h', 'user@'])('rejects %j', text => expect(parseQuickConnect(text)).toBeNull())
})

describe('draft card', () => {
  it('shows a placeholder card while a new host is being entered, and the typed text', () => {
    const {rerender} = render(<HostList groups={[]} hosts={hosts} draft="" onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onForwards={vi.fn()} onEditGroup={vi.fn()} onDeleteGroup={vi.fn()} />)
    expect(screen.getByTestId('draft-card')).toHaveTextContent('Enter IP or Hostname…')
    rerender(<HostList groups={[]} hosts={hosts} draft="new.example.org" onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onForwards={vi.fn()} onEditGroup={vi.fn()} onDeleteGroup={vi.fn()} />)
    expect(screen.getByTestId('draft-card')).toHaveTextContent('new.example.org')
    rerender(<HostList groups={[]} hosts={hosts} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onForwards={vi.fn()} onEditGroup={vi.fn()} onDeleteGroup={vi.fn()} />)
    expect(screen.queryByTestId('draft-card')).toBeNull()
  })

  it('is not counted as a host', () => {
    render(<HostList groups={[]} hosts={[]} draft="" onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onForwards={vi.fn()} onEditGroup={vi.fn()} onDeleteGroup={vi.fn()} />)
    expect(within(screen.getByRole('list', {name: 'Hosts'})).queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.queryByText(/No hosts yet/)).toBeNull()
  })
})

describe('HostList: SFTP action', () => {
  it('shows an SFTP button per host that opens the file browser for that host', async () => {
    const onSftp = vi.fn()
    setup({onSftp})
    await userEvent.click(screen.getByRole('button', {name: 'SFTP db-1'}))
    expect(onSftp).toHaveBeenCalledWith(expect.objectContaining({id: 'b'}))
  })

  it('hides the button when the action is not provided', () => {
    setup()
    expect(screen.queryByRole('button', {name: /^SFTP /})).toBeNull()
  })
})

describe('HostList: server type icon', () => {
  const card = (label: string) => screen.getByText(label, {selector: '.label'}).closest('.host') as HTMLElement

  it('shows the distribution icon once the server type is known, with the environment as a pip', () => {
    setup({hosts: [host({id: 'u', label: 'web-ubuntu', env: 'prod', os: 'ubuntu'} as never), host({id: 'n', label: 'mystery', env: 'dev'})]})
    const tile = card('web-ubuntu').querySelector('.tile') as HTMLElement
    expect(tile).toHaveClass('os-tile')
    expect(tile).toHaveAttribute('data-os', 'ubuntu')
    expect(tile).toHaveAttribute('title', 'Ubuntu · prod')
    expect(tile.querySelector('svg[data-glyph="ubuntu"]')).not.toBeNull()
    expect(tile.querySelector('.env-pip')).toHaveClass('env-prod')
    // not known yet: the generic server icon on the environment colour, as before
    const plain = card('mystery').querySelector('.tile') as HTMLElement
    expect(plain).toHaveClass('env-dev')
    expect(plain).not.toHaveAttribute('data-os')
  })
})
