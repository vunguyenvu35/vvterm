import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {GroupForm, HostForm} from './HostForm'
import {host, makeFake, Providers} from '../../test/fakeBackend'

function setup(h?: ReturnType<typeof host>) {
  const be = makeFake({identities: [{id: 'i1', name: 'deploy', auth_type: 'key'}]})
  const onSaved = vi.fn()
  const onClose = vi.fn()
  const jump = host({id: 'j', label: 'bastion'})
  render(<Providers be={be}><HostForm host={h} groups={[{id: 'g1', name: 'prod', sort_order: 0}]} hosts={[jump, ...(h ? [h] : [])]} identities={be.state.identities} onClose={onClose} onSaved={onSaved} /></Providers>)
  return {be, onSaved, onClose}
}

describe('HostForm', () => {
  it('requires a hostname', async () => {
    const {be} = setup()
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Hostname is required')
    expect(be.state.calls.some(c => c[0] === 'hosts.saveHost')).toBe(false)
  })

  it.each(['0', '70000', 'abc'])('rejects port %s', async port => {
    setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'h')
    await userEvent.clear(screen.getByLabelText('Port'))
    await userEvent.type(screen.getByLabelText('Port'), port)
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Port must be')
  })

  it('rejects spaces in hostname', async () => {
    setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'a b')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot contain spaces')
  })

  it('saves a complete host with tags and jump host', async () => {
    const {be, onSaved} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), '10.0.0.9')
    await userEvent.type(screen.getByLabelText('Username'), 'root')
    await userEvent.selectOptions(screen.getByLabelText('Identity'), 'i1')
    await userEvent.selectOptions(screen.getByLabelText('Group'), 'g1')
    await userEvent.selectOptions(screen.getByLabelText('Environment'), 'prod')
    await userEvent.selectOptions(screen.getByLabelText('Jump host'), 'j')
    await userEvent.type(screen.getByLabelText('Tags'), 'db, db, edge')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const payload = be.state.calls.find(c => c[0] === 'hosts.saveHost')![1] as Record<string, unknown>
    expect(payload).toMatchObject({hostname: '10.0.0.9', username: 'root', identity_id: 'i1', group_id: 'g1', env: 'prod', jump_host_id: 'j', tags: ['db', 'edge'], port: 22})
  })

  it('prefills when editing and excludes itself from the jump list', () => {
    const h = host({id: 'self', label: 'me', hostname: 'me.example', port: 2200, tags: ['x']})
    setup(h)
    expect(screen.getByLabelText('Hostname')).toHaveValue('me.example')
    expect(screen.getByLabelText('Port')).toHaveValue('2200')
    const opts = Array.from((screen.getByLabelText('Jump host') as HTMLSelectElement).options).map(o => o.text)
    expect(opts).toContain('bastion')
    expect(opts).not.toContain('me')
  })

  it('shows backend errors', async () => {
    const {be} = setup()
    be.hosts.saveHost = async () => { throw 'jump host chain forms a loop' }
    await userEvent.type(screen.getByLabelText('Hostname'), 'h')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('forms a loop')
  })
})

describe('GroupForm', () => {
  it('requires a name then saves', async () => {
    const be = makeFake()
    const onSaved = vi.fn()
    render(<Providers be={be}><GroupForm groups={[]} onClose={vi.fn()} onSaved={onSaved} /></Providers>)
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Name is required')
    await userEvent.type(screen.getByLabelText('Group name'), 'staging')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(be.state.groups[0].name).toBe('staging')
  })
})
