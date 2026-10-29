import {act, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {GroupForm, HostForm} from './HostForm'
import {host, makeFake, Providers} from '../../test/fakeBackend'

function setup(h?: ReturnType<typeof host>, over: Partial<React.ComponentProps<typeof HostForm>> = {}) {
  const be = makeFake({identities: [{id: 'i1', name: 'deploy', auth_type: 'key'}]})
  const cb = {onSaved: vi.fn(), onClose: vi.fn(), onConnect: vi.fn(), onDraft: vi.fn()}
  const jump = host({id: 'j', label: 'bastion'})
  render(<Providers be={be}><HostForm host={h} groups={[{id: 'g1', name: 'prod', sort_order: 0}]} hosts={[jump, ...(h ? [h] : [])]} identities={be.state.identities} {...cb} {...over} /></Providers>)
  return {be, ...cb}
}

const savedPayload = (be: ReturnType<typeof makeFake>) => be.state.calls.find(c => c[0] === 'hosts.saveHost')![1] as Record<string, unknown>

describe('HostForm: AI assistant', () => {
  it('has a per-host switch that defaults to off on production hosts and is saved with the host', async () => {
    const {be} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'db.example.com')
    expect(screen.getByRole('combobox', {name: /^AI assistant on this host, Default \(on\)/})).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Environment'), 'prod')
    await userEvent.click(screen.getByRole('combobox', {name: /^AI assistant on this host/}))
    expect(screen.getByRole('option', {name: /Default \(off\)/})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', {name: 'On'}))
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(savedPayload(be)).toMatchObject({ai_policy: 'on', env: 'prod'}))
  })

  it('keeps the stored policy when a host is edited', async () => {
    const {be} = setup(host({id: 'h9', hostname: 'a.example.com', ai_policy: 'off'}))
    expect(screen.getByRole('combobox', {name: /^AI assistant on this host, Off/})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(savedPayload(be)).toMatchObject({ai_policy: 'off'}))
  })
})

describe('HostForm', () => {
  it('follows the Termius flow: address, general, port, credentials, options', () => {
    setup()
    const order = ['Hostname', 'Label', 'Group', 'Environment', 'Tags', 'Port', 'Username', 'Password', 'Identity', 'Jump host', 'Keepalive']
    const els = order.map(l => screen.getByLabelText(l))
    for (let i = 1; i < els.length; i++) {
      expect(els[i - 1].compareDocumentPosition(els[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${order[i]} after ${order[i - 1]}`).toBeTruthy()
    }
    expect(screen.getByRole('button', {name: 'Test connection'})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Save'})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Connect'})).toBeInTheDocument()
  })

  it('is docked (an aside) rather than a modal dialog backdrop', () => {
    setup()
    expect(screen.getByRole('dialog', {name: 'New host'}).tagName).toBe('ASIDE')
    expect(document.querySelector('.modal-back')).toBeNull()
  })

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

  it('Save stores a complete host with a key identity, tags and jump host', async () => {
    const {be, onSaved, onConnect} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), '10.0.0.9')
    await userEvent.type(screen.getByLabelText('Username'), 'root')
    await userEvent.selectOptions(screen.getByLabelText('Identity'), 'i1')
    await userEvent.selectOptions(screen.getByLabelText('Group'), 'g1')
    await userEvent.selectOptions(screen.getByLabelText('Environment'), 'prod')
    await userEvent.selectOptions(screen.getByLabelText('Jump host'), 'j')
    await userEvent.type(screen.getByLabelText('Tags'), 'db, db, edge')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(savedPayload(be)).toMatchObject({hostname: '10.0.0.9', username: 'root', identity_id: 'i1', group_id: 'g1', env: 'prod', jump_host_id: 'j', tags: ['db', 'edge'], port: 22})
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('a typed password becomes a vault identity; the host only references it', async () => {
    const {be, onSaved} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'db.internal')
    await userEvent.type(screen.getByLabelText('Label'), 'db')
    await userEvent.type(screen.getByLabelText('Username'), 'dba')
    await userEvent.type(screen.getByLabelText('Password'), 'S3cret!')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(be.state.calls).toContainEqual(['vault.addPassword', 'db (password)', 'dba', 'S3cret!'])
    const payload = savedPayload(be)
    expect(payload.identity_id).toBe(be.state.identities.find(i => i.name === 'db (password)')!.id)
    expect(JSON.stringify(payload)).not.toContain('S3cret!')
  })

  it('the password field can be revealed and is disabled when an identity is chosen', async () => {
    setup()
    const pw = screen.getByLabelText('Password')
    expect(pw).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', {name: 'Show password'}))
    expect(pw).toHaveAttribute('type', 'text')
    await userEvent.selectOptions(screen.getByLabelText('Identity'), 'i1')
    expect(pw).toBeDisabled()
  })

  it('Connect saves first, then asks to open a terminal for the saved host', async () => {
    const {be, onSaved, onConnect} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'web.example')
    await userEvent.click(screen.getByRole('button', {name: 'Connect'}))
    await waitFor(() => expect(onConnect).toHaveBeenCalled())
    expect(onSaved).toHaveBeenCalled()
    expect(onConnect.mock.calls[0][0]).toMatchObject({hostname: 'web.example'})
    expect(be.state.hosts).toHaveLength(1)
  })

  it('Connect does not open anything when validation fails', async () => {
    const {onConnect} = setup()
    await userEvent.click(screen.getByRole('button', {name: 'Connect'}))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('prefills when editing, keeps the id, and excludes itself from the jump list', async () => {
    const h = host({id: 'self', label: 'me', hostname: 'me.example', port: 2200, tags: ['x'], identity_id: 'i1'})
    const {be, onSaved} = setup(h)
    expect(screen.getByLabelText('Hostname')).toHaveValue('me.example')
    expect(screen.getByLabelText('Port')).toHaveValue('2200')
    const opts = Array.from((screen.getByLabelText('Jump host') as HTMLSelectElement).options).map(o => o.text)
    expect(opts.some(o => o.includes('bastion'))).toBe(true)
    expect(opts.some(o => o.includes(' me'))).toBe(false)
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(savedPayload(be)).toMatchObject({id: 'self', identity_id: 'i1'})
  })

  it('a draft from quick connect creates a new record (no id)', async () => {
    const draft = host({id: '', label: '', hostname: 'new.example.org', port: 2200, username: 'deploy'})
    const {be, onSaved} = setup(draft, {isNew: true})
    expect(screen.getByRole('dialog', {name: 'New host'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(savedPayload(be).id).toBeUndefined()
  })

  it('reports what is being typed so the page can show a draft card', async () => {
    const {onDraft} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'abc')
    expect(onDraft).toHaveBeenLastCalledWith('abc')
    await userEvent.type(screen.getByLabelText('Label'), 'web')
    expect(onDraft).toHaveBeenLastCalledWith('web')
  })

  it('shows backend errors and does not connect', async () => {
    const {be, onConnect} = setup()
    be.hosts.saveHost = async () => { throw 'jump host chain forms a loop' }
    await userEvent.type(screen.getByLabelText('Hostname'), 'h')
    await userEvent.click(screen.getByRole('button', {name: 'Connect'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('forms a loop')
    expect(onConnect).not.toHaveBeenCalled()
  })
})

describe('HostForm: Test connection', () => {
  it('tests the typed values without saving anything', async () => {
    const {be, onSaved} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), '10.0.0.1')
    await userEvent.type(screen.getByLabelText('Username'), 'root')
    await userEvent.type(screen.getByLabelText('Password'), 'pw')
    await userEvent.click(screen.getByRole('button', {name: 'Test connection'}))
    const res = await screen.findByTestId('test-result')
    expect(res).toHaveTextContent('Connection successful')
    expect(res).toHaveTextContent('SSH-2.0-OpenSSH_9.6')
    expect(res).toHaveTextContent('42 ms')
    const call = be.state.calls.find(c => c[0] === 'session.testConnection')!
    expect(call[1]).toMatchObject({hostname: '10.0.0.1', username: 'root'})
    expect(call[2]).toBe('pw')
    expect(String(call[3])).toMatch(/^test-/)
    expect(be.state.calls.some(c => c[0] === 'hosts.saveHost' || c[0] === 'vault.addPassword')).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('does not send the password when an identity is selected', async () => {
    const {be} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'h')
    await userEvent.type(screen.getByLabelText('Username'), 'u')
    await userEvent.type(screen.getByLabelText('Password'), 'typed')
    await userEvent.selectOptions(screen.getByLabelText('Identity'), 'i1')
    await userEvent.click(screen.getByRole('button', {name: 'Test connection'}))
    await screen.findByTestId('test-result')
    expect(be.state.calls.find(c => c[0] === 'session.testConnection')![2]).toBe('')
  })

  it('shows a failed test clearly', async () => {
    const {be} = setup()
    be.state.testResult = {ok: false, message: 'Authentication failed: ssh: unable to authenticate', latency_ms: 0, hops: 1}
    await userEvent.type(screen.getByLabelText('Hostname'), 'h')
    await userEvent.type(screen.getByLabelText('Username'), 'u')
    await userEvent.click(screen.getByRole('button', {name: 'Test connection'}))
    const res = await screen.findByTestId('test-result')
    expect(res).toHaveTextContent('Connection failed')
    expect(res).toHaveTextContent('Authentication failed')
    expect(res).toHaveClass('bad')
  })

  it('validates before testing and reports backend errors', async () => {
    const {be} = setup()
    await userEvent.click(screen.getByRole('button', {name: 'Test connection'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Hostname is required')
    be.session.testConnection = async () => { throw 'enter a username to test the connection' }
    await userEvent.type(screen.getByLabelText('Hostname'), 'h')
    await userEvent.click(screen.getByRole('button', {name: 'Test connection'}))
    expect(await screen.findByText(/enter a username/)).toBeInTheDocument()
  })

  it('asks to trust an unknown host key and answers with the displayed fingerprint', async () => {
    const {be} = setup()
    let key = ''
    let release!: () => void
    be.session.testConnection = (_h, _p, k) => new Promise(r => { key = k; release = () => r(be.state.testResult) })
    await userEvent.type(screen.getByLabelText('Hostname'), 'h')
    await userEvent.type(screen.getByLabelText('Username'), 'u')
    await userEvent.click(screen.getByRole('button', {name: 'Test connection'}))
    await waitFor(() => expect(key).not.toBe(''))
    expect(screen.getByRole('button', {name: 'Testing…'})).toBeDisabled()

    act(() => be.emit('term:hostkey:' + key, {host: 'h:22', fingerprint: 'SHA256:abc', key_type: 'ssh-ed25519'}))
    expect(screen.getByTestId('fingerprint')).toHaveTextContent('SHA256:abc')
    await userEvent.click(screen.getByRole('button', {name: 'Trust and continue'}))
    expect(be.state.calls).toContainEqual(['session.trustHostKey', key, 'SHA256:abc'])
    expect(screen.queryByTestId('fingerprint')).toBeNull()
    release()
    expect(await screen.findByTestId('test-result')).toHaveTextContent('Connection successful')
  })

  it('cancelling the host key prompt rejects it with an empty fingerprint', async () => {
    const {be} = setup()
    let key = ''
    be.session.testConnection = (_h, _p, k) => new Promise(() => { key = k })
    await userEvent.type(screen.getByLabelText('Hostname'), 'h')
    await userEvent.type(screen.getByLabelText('Username'), 'u')
    await userEvent.click(screen.getByRole('button', {name: 'Test connection'}))
    await waitFor(() => expect(key).not.toBe(''))
    act(() => be.emit('term:hostkey:' + key, {host: 'h', fingerprint: 'SHA256:zzz', key_type: 'k'}))
    await userEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    expect(be.state.calls).toContainEqual(['session.trustHostKey', key, ''])
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


describe('HostForm: Telnet and terminal theme', () => {
  const addTelnet = () => userEvent.click(screen.getByRole('button', {name: 'Add Telnet'}))

  it('Telnet is off until "Add Telnet" is pressed, and then comes right after the SSH port', async () => {
    const {be} = setup()
    expect(screen.queryByLabelText('Telnet port')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    await userEvent.type(screen.getByLabelText('Hostname'), 'switch.lan')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(savedPayload(be)).toMatchObject({telnet_enabled: false, telnet_port: 0}))
  })

  it('Add Telnet shows the port (23), a warning, its own username, password and encoding', async () => {
    const {be} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'switch.lan')
    await addTelnet()
    expect(screen.getByLabelText('Telnet port')).toHaveValue('23')
    expect(screen.getByRole('note')).toHaveTextContent(/not encrypted/)
    expect(screen.queryByRole('button', {name: 'Add Telnet'})).toBeNull()
    await userEvent.clear(screen.getByLabelText('Telnet port'))
    await userEvent.type(screen.getByLabelText('Telnet port'), '2323')
    await userEvent.type(screen.getByLabelText('Telnet username'), 'operator')
    const pw = screen.getByLabelText('Telnet password')
    await userEvent.type(pw, 's3cret')
    expect(pw).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', {name: 'Show Telnet password'}))
    expect(pw).toHaveAttribute('type', 'text')
    await userEvent.click(screen.getByRole('combobox', {name: /Telnet encoding/}))
    await userEvent.click(screen.getByRole('option', {name: /ISO-8859-1/}))
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(savedPayload(be)).toMatchObject({telnet_enabled: true, telnet_port: 2323, telnet_username: 'operator', telnet_encoding: 'iso-8859-1'}))
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'hosts.setTelnetPassword' && c[2] === 's3cret')).toBe(true))
    expect(JSON.stringify(savedPayload(be))).not.toContain('s3cret')
  })

  it('refuses a Telnet port that is not a port', async () => {
    const {be} = setup()
    await userEvent.type(screen.getByLabelText('Hostname'), 'switch.lan')
    await addTelnet()
    for (const bad of ['0', '70000', 'abc', '2.5']) {
      await userEvent.clear(screen.getByLabelText('Telnet port'))
      await userEvent.type(screen.getByLabelText('Telnet port'), bad)
      await userEvent.click(screen.getByRole('button', {name: 'Save'}))
      expect(await screen.findByRole('alert')).toHaveTextContent('Telnet port must be between 1 and 65535')
    }
    expect(be.state.calls.some(c => c[0] === 'hosts.saveHost')).toBe(false)
  })

  it('editing a host shows its Telnet settings, and Remove turns Telnet off', async () => {
    const {be} = setup(host({id: 'h1', label: 'sw', telnet_enabled: true, telnet_port: 2323, telnet_username: 'op'} as never))
    expect(screen.getByLabelText('Telnet port')).toHaveValue('2323')
    expect(screen.getByLabelText('Telnet username')).toHaveValue('op')
    await userEvent.click(screen.getByRole('button', {name: 'Remove'}))
    expect(screen.getByRole('button', {name: 'Add Telnet'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(savedPayload(be)).toMatchObject({telnet_enabled: false, telnet_port: 0, telnet_username: ''}))
  })

  it('the theme is a picture card: pick one from the pictures, or go back to the app setting', async () => {
    const {be} = setup()
    expect(screen.getByRole('button', {name: /^Terminal theme, Use the app setting/})).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Hostname'), 'prod.example')
    await userEvent.click(screen.getByRole('button', {name: /^Terminal theme/}))
    await userEvent.click(screen.getByRole('option', {name: /Dracula/}))
    expect(screen.getByRole('button', {name: /^Terminal theme, Dracula/})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(savedPayload(be)).toMatchObject({terminal_theme: 'dracula'}))
  })

  it('an existing host keeps its theme when edited, and can go back to the app setting', async () => {
    const {be} = setup(host({id: 'h1', label: 'sw', terminal_theme: 'nord'} as never))
    expect(screen.getByRole('button', {name: /^Terminal theme, Nord/})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: /^Terminal theme/}))
    await userEvent.click(screen.getByRole('option', {name: /Use the app setting/}))
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(savedPayload(be)).toMatchObject({terminal_theme: ''}))
  })
})
