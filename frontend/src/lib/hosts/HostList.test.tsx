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
  it('shows every host and the group cards with host counts (including sub-groups)', () => {
    setup()
    expect(labels().sort()).toEqual(['box', 'cdn-1', 'db-1', 'web-1']) // every host, also the ones that are in a group
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
    expect(labels().sort()).toEqual(['box', 'cdn-1', 'db-1', 'web-1'])
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
    expect(labels().sort()).toEqual(['box', 'cdn-1', 'db-1', 'web-1'])
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

describe('HostList: no SFTP button on a card', () => {
  it('SFTP lives in its own tab next to Vaults, so a card has no SFTP button, not even on hover', () => {
    setup()
    expect(screen.queryByRole('button', {name: /SFTP/})).toBeNull()
    expect(document.querySelector('.sftp-chip')).toBeNull()
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

describe('HostList: Telnet action', () => {
  it('is offered only for hosts that have Telnet on, and opens that host with Telnet', async () => {
    const onTelnet = vi.fn()
    setup({onTelnet, hosts: [host({id: 't', label: 'switch', telnet_enabled: true, telnet_port: 2323} as never), host({id: 'p', label: 'plain'})]})
    expect(screen.queryByRole('button', {name: 'Telnet plain'})).toBeNull()
    const btn = screen.getByRole('button', {name: 'Telnet switch'})
    expect(btn).toHaveAttribute('title', expect.stringContaining('2323'))
    expect(btn).toHaveAttribute('title', expect.stringContaining('unencrypted'))
    await userEvent.click(btn)
    expect(onTelnet).toHaveBeenCalledWith(expect.objectContaining({id: 't'}))
  })

  it('is not shown without a handler', () => {
    setup({hosts: [host({id: 't', label: 'switch', telnet_enabled: true} as never)]})
    expect(screen.queryByRole('button', {name: 'Telnet switch'})).toBeNull()
  })
})

describe('HostList: Grid / List view', () => {
  beforeEach(() => { try { localStorage.removeItem('vvterm.hostsView') } catch { /* ignore */ } })
  const hostsEl = () => screen.getByRole('list', {name: 'Hosts'})

  it('starts as a grid; the View menu has a check on the current view', async () => {
    setup()
    expect(hostsEl()).toHaveAttribute('data-view', 'grid')
    expect(hostsEl()).not.toHaveClass('as-list')
    await userEvent.click(screen.getByRole('button', {name: 'View'}))
    const menu = screen.getByRole('menu', {name: 'View'})
    expect(within(menu).getByRole('menuitemradio', {name: /Grid/})).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('menuitemradio', {name: /List/})).toHaveAttribute('aria-checked', 'false')
  })

  it('List shows the same hosts as rows, closes the menu, and is remembered', async () => {
    const {unmount} = (() => { setup(); return {unmount: () => {}} })()
    void unmount
    await userEvent.click(screen.getByRole('button', {name: 'View'}))
    await userEvent.click(screen.getByRole('menuitemradio', {name: /List/}))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(hostsEl()).toHaveAttribute('data-view', 'list')
    expect(hostsEl()).toHaveClass('as-list')
    expect(labels().sort()).toEqual(['box', 'cdn-1', 'db-1', 'web-1'])
    expect(screen.getByRole('button', {name: 'View'})).toHaveAttribute('title', 'List view')
    expect(localStorage.getItem('vvterm.hostsView')).toBe('list')
  })

  it('opens in the remembered view', () => {
    localStorage.setItem('vvterm.hostsView', 'list')
    setup()
    expect(hostsEl()).toHaveAttribute('data-view', 'list')
  })

  it('Esc and a click elsewhere close the menu', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', {name: 'View'}))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: 'View'}))
    await userEvent.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('works when the browser storage is unavailable', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    setup()
    expect(hostsEl()).toHaveAttribute('data-view', 'grid')
    await userEvent.click(screen.getByRole('button', {name: 'View'}))
    await userEvent.click(screen.getByRole('menuitemradio', {name: /List/}))
    expect(hostsEl()).toHaveAttribute('data-view', 'list') // it just is not remembered
    get.mockRestore(); set.mockRestore()
  })
})

describe('HostList: drag a host onto a group', () => {
  const dt = () => {
    const data: Record<string, string> = {}
    return {data, types: [] as string[], effectAllowed: '', dropEffect: '',
      setData(k: string, v: string) { data[k] = v; this.types = [k] }, getData: (k: string) => data[k]}
  }
  const card = (name: string) => within(screen.getByRole('list', {name: 'Hosts'})).getAllByRole('listitem').find(e => e.querySelector('.label')?.textContent === name)!

  it('dropping a host card on a group card moves the host there', async () => {
    const onMoveHost = vi.fn()
    setup({onMoveHost})
    const {fireEvent} = await import('@testing-library/react')
    const t = dt()
    fireEvent.dragStart(card('db-1'), {dataTransfer: t})
    const group = screen.getByRole('button', {name: 'Open group prod-cluster'})
    fireEvent.dragOver(group, {dataTransfer: t})
    expect(group).toHaveClass('drop-over')
    fireEvent.drop(group, {dataTransfer: t})
    expect(onMoveHost).toHaveBeenCalledWith(expect.objectContaining({id: 'b'}), 'g1')
    expect(group).not.toHaveClass('drop-over')
  })

  it('inside a group, a host can go into a sub-group or out through "All hosts"', async () => {
    const onMoveHost = vi.fn()
    setup({onMoveHost})
    const {fireEvent} = await import('@testing-library/react')
    await userEvent.click(screen.getByRole('button', {name: 'Open group prod-cluster'}))
    const t = dt()
    fireEvent.dragStart(card('web-1'), {dataTransfer: t})
    const edge = screen.getByRole('button', {name: 'Open group edge'})
    fireEvent.dragOver(edge, {dataTransfer: t})
    fireEvent.drop(edge, {dataTransfer: t})
    expect(onMoveHost).toHaveBeenLastCalledWith(expect.objectContaining({id: 'a'}), 'g2')
    const all = screen.getByRole('button', {name: 'All hosts'})
    fireEvent.dragOver(all, {dataTransfer: t})
    fireEvent.drop(all, {dataTransfer: t})
    expect(onMoveHost).toHaveBeenLastCalledWith(expect.objectContaining({id: 'a'}), '')
  })

  it('cards are not draggable without a handler, and other drags are ignored', async () => {
    setup()
    expect(card('db-1')).not.toHaveAttribute('draggable', 'true')
  })
})
