import {render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {IdentitiesPanel} from './IdentitiesPanel'
import {makeFake, Providers} from '../../test/fakeBackend'

function setup(identities: any[] = []) {
  const be = makeFake({identities})
  const changed = vi.fn()
  render(<Providers be={be}><IdentitiesPanel onClose={vi.fn()} onChanged={changed} /></Providers>)
  return {be, changed}
}

const tab = (n: string) => screen.getByRole('tab', {name: n})

describe('IdentitiesPanel', () => {
  it('lists identities without any secret material', async () => {
    setup([{id: 'i1', name: 'deploy', auth_type: 'key', public_key: 'ssh-ed25519 AAAAB3Nza'}, {id: 'i2', name: 'db', auth_type: 'password'}])
    expect(await screen.findByText('deploy')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/PRIVATE KEY|secret_ref/)
  })

  it('generates a key and shows only the public key', async () => {
    const {be, changed} = setup()
    await userEvent.click(tab('Generate key'))
    await userEvent.type(screen.getByLabelText('Key name'), 'ci')
    await userEvent.click(screen.getByRole('button', {name: 'Generate'}))
    expect(await screen.findByTestId('pubkey')).toHaveTextContent('ssh-ed25519 AAAAgenerated')
    expect(be.state.identities).toHaveLength(1)
    expect(changed).toHaveBeenCalled()
  })

  it('imports a pasted key with passphrase', async () => {
    const {be} = setup()
    await userEvent.click(tab('Import key'))
    await userEvent.type(screen.getByLabelText('Key name'), 'k')
    await userEvent.type(screen.getByLabelText('Private key'), '-----BEGIN-----')
    await userEvent.type(screen.getByLabelText('Passphrase'), 'pp')
    await userEvent.click(screen.getByRole('button', {name: 'Import'}))
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'vault.addKeyPEM' && c[3] === 'pp')).toBe(true))
  })

  it('imports a key from a picked file', async () => {
    const {be} = setup()
    await userEvent.click(tab('Import key'))
    await userEvent.type(screen.getByLabelText('Key name'), 'k')
    await userEvent.click(screen.getByRole('button', {name: 'Browse…'}))
    expect(screen.getByLabelText('Key file path')).toHaveValue('/tmp/picked')
    await userEvent.click(screen.getByRole('button', {name: 'Import'}))
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'vault.addKey' && c[2] === '/tmp/picked')).toBe(true))
  })

  it('saves a password identity and clears the field', async () => {
    const {be} = setup()
    await userEvent.click(tab('Add password'))
    await userEvent.type(screen.getByLabelText('Identity name'), 'pg')
    await userEvent.type(screen.getByLabelText('Username'), 'dba')
    await userEvent.type(screen.getByLabelText('Password'), 's3cret')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(be.state.identities).toHaveLength(1))
    expect(be.state.calls.find(c => c[0] === 'vault.addPassword')).toEqual(['vault.addPassword', 'pg', 'dba', 's3cret'])
    expect(document.body.textContent).not.toContain('s3cret')
  })

  it('reports backend errors', async () => {
    const {be} = setup()
    be.vault.generateKey = async () => { throw 'vault is locked: unlock it first' }
    await userEvent.click(tab('Generate key'))
    await userEvent.type(screen.getByLabelText('Key name'), 'x')
    await userEvent.click(screen.getByRole('button', {name: 'Generate'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('locked')
  })

  it('deletes an identity after confirmation and surfaces in-use errors', async () => {
    const {be} = setup([{id: 'i1', name: 'used', auth_type: 'password'}, {id: 'i2', name: 'free', auth_type: 'password'}])
    be.state.hosts = [{id: 'h', label: 'x', hostname: 'x', port: 22, username: '', keepalive_sec: 30, identity_id: 'i1'}]
    await screen.findByText('used')
    await userEvent.click(screen.getByLabelText('Delete free'))
    await waitFor(() => expect(be.state.identities.map(i => i.id)).toEqual(['i1']))
    await userEvent.click(screen.getByLabelText('Delete used'))
    expect(await screen.findByText(/used by a host/)).toBeInTheDocument()
    expect(within(document.body).getByText('used')).toBeInTheDocument()
  })
})
