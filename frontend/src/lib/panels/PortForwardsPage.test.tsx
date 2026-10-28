import {render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {useState} from 'react'
import {PortForwardsPage, describeForward, forwardTitle} from './PortForwardsPage'
import {ForwardPanel} from './ForwardPanel'
import {host, makeFake, Providers} from '../../test/fakeBackend'
import type {ForwardType, PortForward} from '../types'

const h1 = host({id: 'h1', label: 'bastion', hostname: 'bastion.example.com'})
const h2 = host({id: 'h2', label: 'db-box', hostname: 'db.example.com'})
const fw: PortForward = {id: 'f1', host_id: 'h1', type: 'local', bind_addr: '127.0.0.1', bind_port: 3306, dest_host: 'db', dest_port: 3306, auto_start: false}

function Harness({be, hostId}: {be: ReturnType<typeof makeFake>; hostId?: string}) {
  const [panel, setPanel] = useState<{forward?: PortForward} | null>(hostId ? {} : null)
  const [draft, setDraft] = useState<{label: string; type: ForwardType}>({label: '', type: 'local'})
  const [tick, setTick] = useState(0)
  const hosts = [h1, h2]
  return (
    <>
      <PortForwardsPage hosts={hosts} draft={panel && !panel.forward ? draft : undefined} reloadKey={tick}
        onNew={() => { setDraft({label: '', type: 'local'}); setPanel({}) }} onEdit={f => setPanel({forward: f})} />
      {panel && <ForwardPanel key={panel.forward?.id ?? 'new'} hosts={hosts} forward={panel.forward} hostId={hostId} onClose={() => setPanel(null)} onChanged={() => setTick(n => n + 1)} onDraft={setDraft} />}
    </>
  )
}
const mount = (init: Parameters<typeof makeFake>[0] = {}, hostId?: string) => {
  const be = makeFake(init)
  render(<Providers be={be}><Harness be={be} hostId={hostId} /></Providers>)
  return be
}

describe('Port Forwarding page', () => {
  it('lists rules as cards: letter, name, host, mapping and state; Stop works', async () => {
    const be = mount({forwards: [fw], running: {f1: '127.0.0.1:3306'}})
    const card = (await screen.findByText('Local Rule')).closest('.card') as HTMLElement
    expect(card.querySelector('.tile')).toHaveTextContent('L')
    expect(card).toHaveTextContent('bastion · 127.0.0.1:3306 → db:3306 · running')
    expect(card).toHaveTextContent('listening on 127.0.0.1:3306')
    await userEvent.click(within(card).getByRole('button', {name: 'Stop Local Rule'}))
    await waitFor(() => expect(card).toHaveTextContent('stopped'))
    expect(be.state.running).toEqual({})
  })

  it('uses the label as the name, and L / R / D for the three types', async () => {
    mount({forwards: [{...fw, label: 'MySQL prod'}, {...fw, id: 'f2', type: 'remote'}, {...fw, id: 'f3', type: 'dynamic'}]})
    expect(await screen.findByText('MySQL prod')).toBeInTheDocument()
    expect(screen.getByText('Remote Rule')).toBeInTheDocument()
    expect(screen.getByText('Dynamic Rule')).toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('.card .tile')).map(t => t.textContent)).toEqual(['L', 'R', 'D'])
    expect(forwardTitle({...fw, label: ''})).toBe('Local Rule')
    expect(describeForward({...fw, type: 'dynamic', bind_port: 0})).toBe('SOCKS5 127.0.0.1:auto')
  })

  it('says what to do when there are none', async () => {
    mount()
    expect(await screen.findByText(/No port forwards yet/)).toBeInTheDocument()
  })

  it('reacts to forward:state events', async () => {
    const be = mount({forwards: [fw]})
    expect(await screen.findByText(/stopped/)).toBeInTheDocument()
    be.state.running = {f1: '127.0.0.1:3306'}
    be.emit('forward:state', {id: 'f1'})
    expect(await screen.findByText(/running/)).toBeInTheDocument()
  })

  it('Start shows a host key prompt when the host is unknown and answers with the displayed fingerprint', async () => {
    const be = mount({forwards: [{...fw, type: 'dynamic'}]})
    let release!: () => void
    be.forwards.start = () => new Promise<void>(r => { release = r })
    await userEvent.click(await screen.findByRole('button', {name: 'Start Dynamic Rule'}))
    be.emit('term:hostkey:fwd-f1', {host: 'bastion', fingerprint: 'SHA256:abc', key_type: 'ssh-ed25519'})
    const dlg = await screen.findByRole('alertdialog', {name: 'Host key confirmation'})
    expect(dlg).toHaveTextContent('SHA256:abc')
    await userEvent.click(within(dlg).getByRole('button', {name: 'Trust and connect'}))
    expect(be.state.calls).toContainEqual(['session.trustHostKey', 'fwd-f1', 'SHA256:abc'])
    release()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('deletes after confirming', async () => {
    const be = mount({forwards: [fw]})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
    await userEvent.click(await screen.findByRole('button', {name: 'Delete Local Rule'}))
    expect(be.state.forwards).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', {name: 'Delete Local Rule'}))
    await waitFor(() => expect(be.state.forwards).toHaveLength(0))
    confirm.mockRestore()
  })
})

describe('New Port Forwarding panel', () => {
  it('starts with the wizard: pick Local / Remote / Dynamic, see a picture and a description', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', {name: 'New forwarding'}))
    const panel = screen.getByRole('dialog', {name: 'New Port Forwarding'})
    expect(panel.tagName).toBe('ASIDE')
    expect(within(panel).getByText('Select the port forwarding type:')).toBeInTheDocument()
    expect(within(panel).getByRole('radio', {name: 'Local'})).toBeChecked()
    expect(within(panel).getByRole('img')).toHaveAttribute('data-type', 'local')
    expect(within(panel).getByText(/access a remote server's listening port as though it were local/)).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('radio', {name: 'Remote'}))
    expect(within(panel).getByRole('img')).toHaveAttribute('data-type', 'remote')
    expect(within(panel).getByText(/Remote forwarding opens a port on the SSH host/)).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('radio', {name: 'Dynamic'}))
    expect(within(panel).getByText(/SOCKS5 proxy/)).toBeInTheDocument()
    expect(screen.getByTestId('draft-card')).toHaveTextContent('Dynamic Rule')
  })

  it('Continue walks through port → host → destination → name, with Back at every step', async () => {
    const be = mount()
    await userEvent.click(await screen.findByRole('button', {name: 'New forwarding'}))
    await userEvent.click(screen.getByRole('button', {name: 'Continue'}))
    expect(screen.getByRole('dialog', {name: 'Local Port Forwarding'})).toBeInTheDocument()
    expect(screen.getByText('Set the local port and binding address:')).toBeInTheDocument()
    expect(screen.getByText(/open on the local \(current\) machine/)).toBeInTheDocument()
    const next = () => screen.getByRole('button', {name: 'Continue'})
    expect(next()).toBeDisabled() // the port is required
    await userEvent.type(screen.getByLabelText('Local port number'), '99999')
    expect(next()).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Local port number'))
    await userEvent.type(screen.getByLabelText('Local port number'), '3306')
    await userEvent.click(next())
    // pick the host
    const hostPanel = screen.getByRole('dialog', {name: 'Select Host'})
    await userEvent.type(within(hostPanel).getByLabelText('Search hosts'), 'db')
    expect(within(hostPanel).queryByRole('button', {name: 'Use host bastion'})).toBeNull()
    await userEvent.click(within(hostPanel).getByRole('button', {name: 'Back'}))
    expect(screen.getByLabelText('Local port number')).toHaveValue('3306') // Back keeps what was typed
    await userEvent.click(next())
    await userEvent.click(within(screen.getByRole('dialog', {name: 'Select Host'})).getByRole('button', {name: 'Use host db-box'}))
    // destination
    expect(screen.getByText('Set the destination address and port:')).toBeInTheDocument()
    expect(screen.getByText(/as seen from the host/)).toBeInTheDocument()
    expect(next()).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Destination host'), '127.0.0.1')
    await userEvent.type(screen.getByLabelText('Destination port'), '5432')
    await userEvent.click(next())
    // name and save
    expect(screen.getByText('Name this rule:')).toBeInTheDocument()
    expect(screen.getByText(/db-box · 127\.0\.0\.1:3306 → 127\.0\.0\.1:5432/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Label'), 'Postgres')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(be.state.forwards[0]).toMatchObject({host_id: 'h2', type: 'local', label: 'Postgres', bind_port: 3306, dest_host: '127.0.0.1', dest_port: 5432})
    expect(await screen.findByText('Postgres', {selector: '.label'})).toBeInTheDocument()
  })

  it('Remote says so at each step; Dynamic skips the destination', async () => {
    const be = mount()
    await userEvent.click(await screen.findByRole('button', {name: 'New forwarding'}))
    await userEvent.click(screen.getByRole('radio', {name: 'Remote'}))
    await userEvent.click(screen.getByRole('button', {name: 'Continue'}))
    expect(screen.getByRole('dialog', {name: 'Remote Port Forwarding'})).toBeInTheDocument()
    expect(screen.getByText('Set the remote port and binding address:')).toBeInTheDocument()
    expect(screen.getByLabelText('Remote port number')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Back'}))
    await userEvent.click(screen.getByRole('radio', {name: 'Dynamic'}))
    await userEvent.click(screen.getByRole('button', {name: 'Continue'}))
    await userEvent.type(screen.getByLabelText('Local port number'), '1080')
    await userEvent.click(screen.getByRole('button', {name: 'Continue'}))
    await userEvent.click(within(screen.getByRole('dialog', {name: 'Select Host'})).getByRole('button', {name: 'Use host bastion'}))
    expect(screen.getByText('Name this rule:')).toBeInTheDocument() // no destination for SOCKS5
    expect(screen.queryByLabelText('Destination host')).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(be.state.forwards).toHaveLength(1))
    expect(be.state.forwards[0]).toMatchObject({type: 'dynamic', host_id: 'h1', bind_port: 1080, dest_host: '', dest_port: 0})
  })

  it('Skip wizard shows everything on one page', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', {name: 'New forwarding'}))
    await userEvent.click(screen.getByRole('button', {name: 'Skip wizard'}))
    expect(screen.getByLabelText('Bind port')).toBeInTheDocument()
    expect(screen.getByLabelText('Destination host')).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: 'Back'})).toBeNull()
  })

  it('adds a local rule and shows it as a card; the draft card follows the label', async () => {
    const be = mount()
    await userEvent.click(await screen.findByRole('button', {name: 'New forwarding'}))
    await userEvent.click(screen.getByRole('button', {name: 'Skip wizard'}))
    await userEvent.type(screen.getByLabelText('Label'), 'MySQL')
    expect(screen.getByTestId('draft-card')).toHaveTextContent('MySQL')
    await userEvent.type(screen.getByLabelText('Bind port'), '3306')
    await userEvent.type(screen.getByLabelText('Destination host'), '127.0.0.1')
    await userEvent.type(screen.getByLabelText('Destination port'), '3306')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(be.state.forwards[0]).toMatchObject({host_id: 'h1', type: 'local', label: 'MySQL', bind_port: 3306, dest_host: '127.0.0.1', dest_port: 3306})
    expect(await screen.findByText('MySQL', {selector: '.label'})).toBeInTheDocument()
    expect(screen.queryByTestId('draft-card')).toBeNull()
  })

  it('Dynamic hides the destination fields and sends none', async () => {
    const be = mount()
    await userEvent.click(await screen.findByRole('button', {name: 'New forwarding'}))
    await userEvent.click(screen.getByRole('radio', {name: 'Dynamic'}))
    await userEvent.click(screen.getByRole('button', {name: 'Skip wizard'}))
    expect(screen.queryByLabelText('Destination host')).toBeNull()
    await userEvent.type(screen.getByLabelText('Bind port'), '1080')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(be.state.forwards).toHaveLength(1))
    expect(be.state.forwards[0]).toMatchObject({type: 'dynamic', bind_port: 1080, dest_host: '', dest_port: 0})
  })

  it('the host card button opens the wizard with that host chosen: the host step is skipped', async () => {
    const be = mount({}, 'h2')
    await userEvent.click(await screen.findByRole('button', {name: 'Continue'}))
    await userEvent.type(screen.getByLabelText('Local port number'), '8080')
    await userEvent.click(screen.getByRole('button', {name: 'Continue'}))
    expect(screen.getByText('Set the destination address and port:')).toBeInTheDocument() // not "Select Host"
    await userEvent.type(screen.getByLabelText('Destination host'), 'x')
    await userEvent.type(screen.getByLabelText('Destination port'), '80')
    await userEvent.click(screen.getByRole('button', {name: 'Continue'}))
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(be.state.forwards[0].host_id).toBe('h2'))
  })

  it('edits an existing rule (no wizard) and keeps its id', async () => {
    const be = mount({forwards: [{...fw, label: 'old'}]})
    await userEvent.click(await screen.findByRole('button', {name: 'Edit old'}))
    expect(screen.getByRole('dialog', {name: 'Edit Port Forwarding'})).toBeInTheDocument()
    const label = screen.getByLabelText('Label')
    await userEvent.clear(label)
    await userEvent.type(label, 'new')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(be.state.forwards[0]).toMatchObject({id: 'f1', label: 'new'}))
    expect(be.state.forwards).toHaveLength(1)
  })

  it('shows the validation error from the backend and keeps the panel open', async () => {
    const be = mount()
    be.forwards.save = async () => { throw 'destination host and port are required' }
    await userEvent.click(await screen.findByRole('button', {name: 'New forwarding'}))
    await userEvent.click(screen.getByRole('button', {name: 'Skip wizard'}))
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('destination host and port')
    expect(screen.getByRole('dialog', {name: 'Local Port Forwarding'})).toBeInTheDocument()
  })
})
