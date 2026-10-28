import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {DataPanel} from './DataPanel'
import {SyncPanel} from './SyncPanel'
import {makeFake, Providers} from '../../test/fakeBackend'

const vaultSt = {exists: true, unlocked: true, keychain_enabled: false, auto_lock_minutes: 15}

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
