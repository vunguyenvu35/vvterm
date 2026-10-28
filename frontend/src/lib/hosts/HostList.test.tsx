import {render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {HostList} from './HostList'
import {host} from '../../test/fakeBackend'
import type {Group} from '../types'

const groups: Group[] = [{id: 'g1', name: 'prod-cluster', sort_order: 0}]
const hosts = [
  host({id: 'a', label: 'web-1', hostname: 'w1.example.com', env: 'prod', group_id: 'g1', tags: ['nginx']}),
  host({id: 'b', label: 'db-1', hostname: 'db.internal', env: 'staging', tags: ['mariadb']}),
  host({id: 'c', label: 'box', hostname: '10.1.1.1', username: 'alice', env: 'dev'}),
]

function setup() {
  const cb = {onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onForwards: vi.fn(), onEditGroup: vi.fn(), onDeleteGroup: vi.fn()}
  render(<HostList groups={groups} hosts={hosts} {...cb} />)
  return cb
}

const labels = () => within(screen.getByRole('list', {name: 'Hosts'})).getAllByRole('listitem').map(e => e.querySelector('.label')?.textContent)

describe('HostList', () => {
  it('shows grouped and ungrouped hosts with the group count', () => {
    setup()
    expect(labels().sort()).toEqual(['box', 'db-1', 'web-1'])
    expect(screen.getByText('prod-cluster')).toBeInTheDocument()
  })

  it('searches by label, hostname, user and tag', async () => {
    setup()
    const box = screen.getByLabelText('Search hosts')
    await userEvent.type(box, 'MARIADB')
    expect(labels()).toEqual(['db-1'])
    await userEvent.clear(box)
    await userEvent.type(box, 'alice')
    expect(labels()).toEqual(['box'])
    await userEvent.clear(box)
    await userEvent.type(box, 'zzz')
    expect(screen.getByText('No hosts match.')).toBeInTheDocument()
  })

  it('filters by environment and toggles off', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', {name: '● prod'}))
    expect(labels()).toEqual(['web-1'])
    await userEvent.click(screen.getByRole('button', {name: '● prod'}))
    expect(labels()).toHaveLength(3)
  })

  it('connects on double click and via the action buttons', async () => {
    const cb = setup()
    await userEvent.dblClick(screen.getByText('db-1'))
    expect(cb.onConnect).toHaveBeenCalledWith(hosts[1])
    await userEvent.click(screen.getByLabelText('Edit web-1'))
    await userEvent.click(screen.getByLabelText('Forwards web-1'))
    await userEvent.click(screen.getByLabelText('Delete web-1'))
    expect(cb.onEdit).toHaveBeenCalledWith(hosts[0])
    expect(cb.onForwards).toHaveBeenCalledWith(hosts[0])
    expect(cb.onDelete).toHaveBeenCalledWith(hosts[0])
  })

  it('collapses a group', async () => {
    setup()
    await userEvent.click(screen.getByText('prod-cluster'))
    expect(labels()).not.toContain('web-1')
  })

  it('shows an empty-state hint', () => {
    render(<HostList groups={[]} hosts={[]} onConnect={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onForwards={vi.fn()} onEditGroup={vi.fn()} onDeleteGroup={vi.fn()} />)
    expect(screen.getByText(/No hosts yet/)).toBeInTheDocument()
  })
})
