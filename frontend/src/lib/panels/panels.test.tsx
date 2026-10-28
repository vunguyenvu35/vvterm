import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ForwardsPanel} from './ForwardsPanel'
import {DataPanel} from './DataPanel'
import {SyncPanel} from './SyncPanel'
import {SettingsPanel} from './SettingsPanel'
import {host, makeFake, Providers} from '../../test/fakeBackend'

const vaultSt = {exists: true, unlocked: true, keychain_enabled: false, auto_lock_minutes: 15}

describe('ForwardsPanel', () => {
  it('adds, starts, stops and deletes a local forward', async () => {
    const h = host({id: 'h1'})
    const be = makeFake({forwards: []})
    render(<Providers be={be}><ForwardsPanel host={h} onClose={vi.fn()} /></Providers>)
    await userEvent.type(screen.getByLabelText('Bind port'), '3306')
    await userEvent.type(screen.getByLabelText('Destination host'), '127.0.0.1')
    await userEvent.type(screen.getByLabelText('Destination port'), '3306')
    await userEvent.click(screen.getByRole('button', {name: 'Add forward'}))
    expect(await screen.findByText(/127\.0\.0\.1:3306 → 127\.0\.0\.1:3306/)).toBeInTheDocument()
    expect(be.state.forwards[0]).toMatchObject({host_id: 'h1', type: 'local', bind_port: 3306, dest_port: 3306})

    await userEvent.click(screen.getByRole('button', {name: 'Start'}))
    expect(await screen.findByText(/listening on 127\.0\.0\.1:5555/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Stop'}))
    await waitFor(() => expect(screen.queryByText(/listening on/)).toBeNull())
    await userEvent.click(screen.getByLabelText('Delete forward'))
    await waitFor(() => expect(be.state.forwards).toHaveLength(0))
  })

  it('hides destination fields for SOCKS5 and describes it', async () => {
    const be = makeFake()
    render(<Providers be={be}><ForwardsPanel host={host({id: 'h1'})} onClose={vi.fn()} /></Providers>)
    await userEvent.selectOptions(screen.getByLabelText('Forward type'), 'dynamic')
    expect(screen.queryByLabelText('Destination host')).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: 'Add forward'}))
    expect(await screen.findByText(/SOCKS5 127\.0\.0\.1:auto/)).toBeInTheDocument()
  })

  it('shows a host key prompt while starting and answers with the displayed fingerprint', async () => {
    const be = makeFake({forwards: [{id: 'f1', host_id: 'h1', type: 'dynamic', bind_addr: '127.0.0.1', bind_port: 0, auto_start: false}]})
    let release!: () => void
    be.forwards.start = () => new Promise<void>(r => { release = r })
    render(<Providers be={be}><ForwardsPanel host={host({id: 'h1'})} onClose={vi.fn()} /></Providers>)
    await userEvent.click(await screen.findByRole('button', {name: 'Start'}))
    be.emit('term:hostkey:fwd-f1', {host: 'bastion', fingerprint: 'SHA256:abc', key_type: 'ssh-ed25519'})
    expect(await screen.findByText('SHA256:abc')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Trust and connect'}))
    expect(be.state.calls).toContainEqual(['session.trustHostKey', 'fwd-f1', 'SHA256:abc'])
    release()
    await waitFor(() => expect(screen.queryByText('SHA256:abc')).toBeNull())
  })

  it('shows backend validation errors', async () => {
    const be = makeFake()
    be.forwards.save = async () => { throw 'destination host and port are required' }
    render(<Providers be={be}><ForwardsPanel host={host({id: 'h1'})} onClose={vi.fn()} /></Providers>)
    await userEvent.click(screen.getByRole('button', {name: 'Add forward'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('destination host and port')
  })
})

describe('DataPanel', () => {
  it('imports an ssh config and shows the report with warnings', async () => {
    const be = makeFake()
    const changed = vi.fn()
    render(<Providers be={be}><DataPanel onClose={vi.fn()} onChanged={changed} /></Providers>)
    expect(screen.getByRole('button', {name: 'Import'})).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Config path'), '/home/me/.ssh/config')
    await userEvent.selectOptions(screen.getByLabelText('Conflict policy'), 'overwrite')
    await userEvent.click(screen.getByRole('button', {name: 'Import'}))
    const rep = await screen.findByTestId('import-report')
    expect(rep).toHaveTextContent('Added 2 hosts, 1 groups')
    expect(rep).toHaveTextContent('ProxyCommand ignored')
    expect(rep).toHaveTextContent('Skipped: dup')
    expect(be.state.calls).toContainEqual(['data.import', '/home/me/.ssh/config', 'overwrite'])
    expect(changed).toHaveBeenCalled()
  })

  it('warns before exporting private keys', async () => {
    const be = makeFake()
    render(<Providers be={be}><DataPanel onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    expect(screen.queryByText(/written to disk unencrypted/)).toBeNull()
    await userEvent.click(screen.getByLabelText('Also export private keys'))
    expect(screen.getByText(/written to disk unencrypted/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Export…'}))
    await waitFor(() => expect(be.state.calls).toContainEqual(['data.exportSSH', '/tmp/dir', true]))
  })

  it('requires an 8+ character backup password', async () => {
    const be = makeFake()
    render(<Providers be={be}><DataPanel onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    const exp = screen.getByRole('button', {name: 'Export backup…'})
    expect(exp).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Backup password'), 'short')
    expect(exp).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Backup password'), 'er-pass')
    expect(exp).toBeEnabled()
    await userEvent.click(exp)
    await waitFor(() => expect(be.state.calls).toContainEqual(['data.exportBackup', '/tmp/vvterm.vvbak', 'shorter-pass']))
    await userEvent.click(screen.getByRole('button', {name: 'Restore backup…'}))
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'data.importBackup')).toBe(true))
  })

  it('exports metadata-only JSON', async () => {
    const be = makeFake()
    render(<Providers be={be}><DataPanel onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    await userEvent.click(screen.getByRole('button', {name: /Export host list/}))
    await waitFor(() => expect(be.state.calls).toContainEqual(['data.exportJSON', '/tmp/vvterm-hosts.json']))
  })

  it('surfaces backend errors', async () => {
    const be = makeFake()
    be.data.importBackup = async () => { throw 'wrong master password' }
    render(<Providers be={be}><DataPanel onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    await userEvent.type(screen.getByLabelText('Backup password'), 'whatever1')
    await userEvent.click(screen.getByRole('button', {name: 'Restore backup…'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong master password')
  })
})

describe('SyncPanel', () => {
  it('saves the repo and syncs', async () => {
    const be = makeFake()
    render(<Providers be={be}><SyncPanel vault={vaultSt} onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    expect(await screen.findByLabelText('Repository URL')).toHaveValue('git@example.com:me/sync.git')
    await userEvent.click(screen.getByRole('button', {name: 'Sync now'}))
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'sync.syncNow')).toBe(true))
    expect(screen.getByTestId('sync-status')).toHaveTextContent('Never synced')
  })

  it('disables sync while the vault is locked and join once a vault exists', async () => {
    const be = makeFake()
    render(<Providers be={be}><SyncPanel vault={{...vaultSt, unlocked: false}} onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    expect(await screen.findByRole('button', {name: 'Sync now'})).toBeDisabled()
    expect(screen.getByRole('button', {name: 'Restore from repository'})).toBeDisabled()
  })

  it('restores on a new machine', async () => {
    const be = makeFake()
    render(<Providers be={be}><SyncPanel vault={{exists: false, unlocked: false, keychain_enabled: false, auto_lock_minutes: 15}} onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    await userEvent.type(await screen.findByLabelText('Synced master password'), 'pw')
    await userEvent.click(screen.getByRole('button', {name: 'Restore from repository'}))
    await waitFor(() => expect(be.state.calls).toContainEqual(['sync.join', 'pw']))
  })

  it('shows sync errors', async () => {
    const be = makeFake()
    be.sync.syncNow = async () => { throw 'remote bundle was encrypted with a different vault key' }
    render(<Providers be={be}><SyncPanel vault={vaultSt} onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    await userEvent.click(await screen.findByRole('button', {name: 'Sync now'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('different vault key')
  })
})

describe('SettingsPanel', () => {
  it('saves appearance and applies it', async () => {
    const be = makeFake()
    const onSettings = vi.fn()
    render(<Providers be={be}><SettingsPanel vault={vaultSt} onClose={vi.fn()} onSettings={onSettings} onVault={vi.fn()} /></Providers>)
    await userEvent.selectOptions(await screen.findByLabelText('Theme'), 'light')
    await userEvent.click(screen.getByRole('button', {name: 'Save appearance'}))
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({theme: 'light'})))
  })

  it('updates auto-lock and toggles keychain unlock', async () => {
    const be = makeFake()
    const onVault = vi.fn()
    render(<Providers be={be}><SettingsPanel vault={vaultSt} onClose={vi.fn()} onSettings={vi.fn()} onVault={onVault} /></Providers>)
    const f = await screen.findByLabelText('Auto-lock minutes')
    await userEvent.clear(f)
    await userEvent.type(f, '5')
    await userEvent.click(screen.getByRole('button', {name: 'Apply'}))
    await waitFor(() => expect(be.state.calls).toContainEqual(['vault.setAutoLock', 5]))
    await userEvent.click(screen.getByRole('button', {name: 'Enable keychain unlock'}))
    await waitFor(() => expect(be.state.vault.keychain_enabled).toBe(true))
    expect(onVault).toHaveBeenCalled()
  })

  it('changes the master password only with a 12+ char new password and reports a wrong current one', async () => {
    const be = makeFake()
    render(<Providers be={be}><SettingsPanel vault={vaultSt} onClose={vi.fn()} onSettings={vi.fn()} onVault={vi.fn()} /></Providers>)
    const btn = await screen.findByRole('button', {name: 'Change password'})
    await userEvent.type(screen.getByLabelText('Current password'), 'wrong one')
    await userEvent.type(screen.getByLabelText('New password'), 'short')
    expect(btn).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('New password'))
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new password')
    await userEvent.click(btn)
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong master password')
    await userEvent.clear(screen.getByLabelText('Current password'))
    await userEvent.type(screen.getByLabelText('Current password'), be.state.password)
    await userEvent.click(btn)
    await waitFor(() => expect(be.state.password).toBe('a brand new password'))
  })
})

describe('null slices from Go (regression)', () => {
  it('DataPanel renders an import report whose arrays are null', async () => {
    const be = makeFake()
    be.data.importSSHConfig = async () => ({hosts_added: 1, groups_added: 0, forwards_added: 0, keys_imported: 0, skipped: null as never, warnings: null as never})
    render(<Providers be={be}><DataPanel onClose={vi.fn()} onChanged={vi.fn()} /></Providers>)
    await userEvent.type(screen.getByLabelText('Config path'), '/x')
    await userEvent.click(screen.getByRole('button', {name: 'Import'}))
    expect(await screen.findByTestId('import-report')).toHaveTextContent('Added 1 hosts')
  })

  it('the Wails adapter normalises null report arrays', async () => {
    const {normalizeImport, normalizeExport} = await import('../backend')
    expect(normalizeImport({skipped: null, warnings: null} as never)).toMatchObject({skipped: [], warnings: []})
    expect(normalizeExport({files: null, key_files: null, warnings: null} as never)).toMatchObject({files: [], key_files: [], warnings: []})
  })
})
