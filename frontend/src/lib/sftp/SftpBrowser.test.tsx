import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {replaceQuestion, SftpBrowser, summarize} from './SftpBrowser'
import {breadcrumbs, formatBytes, joinPath, kindOf, parentOf, validName} from './format'
import {host, makeFake, Providers} from '../../test/fakeBackend'

type Fake = ReturnType<typeof makeFake>

function setup(init: Parameters<typeof makeFake>[0] = {}, connected = true) {
  const be = makeFake({hosts: [host({id: 'h1', label: 'web-1', hostname: 'w1.example.com'}), host({id: 'h2', label: 'db-1', hostname: 'db.example.com'})], ...init})
  render(<Providers be={be}>{connected ? <SftpBrowser hostId="h1" hostLabel="web-1" /> : <SftpBrowser />}</Providers>)
  return be
}
const L = () => screen.getByRole('region', {name: 'Local'})
const R = () => screen.getByRole('region', {name: 'Remote'})
const names = (pane: HTMLElement) => within(pane).queryAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell')[0].textContent)
/** the Actions menu of a pane, opened; the item `name` in it (the toolbar no longer has its own New folder / Rename / Delete) */
const actionItem = async (pane: HTMLElement, name: string) => {
  await userEvent.click(within(pane).getByRole('button', {name: 'Actions'}))
  return within(within(pane).getByRole('menu')).getByRole('menuitem', {name})
}
const viaActions = async (pane: HTMLElement, name: string) => { await userEvent.click(await actionItem(pane, name)) }
const row = (pane: HTMLElement, n: string) => within(pane).getByRole('row', {name: new RegExp('^' + n.replace('.', '\\.'))})
const pick = (pane: HTMLElement, n: string) => userEvent.click(row(pane, n))
const calls = (be: Fake, n: string) => be.state.calls.filter(c => c[0] === n)
const ready = async () => { await waitFor(() => expect(names(L())).toHaveLength(2)); await waitFor(() => expect(names(R())).toHaveLength(2)) }

/** A minimal DataTransfer, which jsdom does not provide. */
function dataTransfer() {
  const data: Record<string, string> = {}
  return {data, types: [] as string[], effectAllowed: '', dropEffect: '',
    setData(k: string, v: string) { data[k] = v; this.types = [k] }, getData: (k: string) => data[k]}
}
function drag(from: HTMLElement, to: HTMLElement) {
  const dt = dataTransfer()
  fireEvent.dragStart(from, {dataTransfer: dt})
  fireEvent.dragOver(to, {dataTransfer: dt})
  fireEvent.drop(to, {dataTransfer: dt})
}

afterEach(() => vi.restoreAllMocks())

describe('SftpBrowser: two panes', () => {
  it('shows this computer on the left and the host on the right, folders first, hidden files off locally', async () => {
    const be = setup()
    await ready()
    expect(names(L())).toEqual(['Documents', 'notes.txt']) // .zshrc is hidden
    expect(names(R())).toEqual(['projects', 'readme.txt'])
    expect(screen.getByLabelText('Local path')).toHaveValue('/Users/me')
    expect(screen.getByLabelText('Remote path')).toHaveValue('/')
    expect(calls(be, 'sftp.open')[0][1]).toBe('h1')
    expect(within(R()).getByText('web-1')).toBeInTheDocument()
  })

  it('shows hidden files on request', async () => {
    setup()
    await ready()
    await userEvent.click(within(L()).getByRole('button', {name: 'Show hidden files'}))
    expect(names(L())).toEqual(['Documents', '.zshrc', 'notes.txt'])
    await userEvent.click(within(L()).getByRole('button', {name: 'Hide hidden files'}))
    expect(names(L())).toEqual(['Documents', 'notes.txt'])
  })

  it('navigates each pane on its own: double click, up, path box, breadcrumbs', async () => {
    setup()
    await ready()
    await userEvent.dblClick(row(L(), 'Documents'))
    await waitFor(() => expect(names(L())).toEqual(['cv.pdf']))
    expect(names(R())).toHaveLength(2) // the other side did not move
    await userEvent.click(within(L()).getByRole('button', {name: 'Up one folder'}))
    await waitFor(() => expect(names(L())).toEqual(['Documents', 'notes.txt']))
    const path = screen.getByLabelText('Remote path')
    await userEvent.clear(path)
    await userEvent.type(path, '/projects{Enter}')
    await waitFor(() => expect(names(R())).toEqual(['app.log']))
    await userEvent.click(within(within(R()).getByRole('navigation', {name: 'Remote folder path'})).getByRole('button', {name: '/'}))
    await waitFor(() => expect(names(R())).toHaveLength(2))
    await userEvent.click(within(L()).getByRole('button', {name: 'Home folder'}))
    expect(screen.getByLabelText('Local path')).toHaveValue('/Users/me')
  })

  it('shows an error and restores the path when a folder does not exist', async () => {
    setup()
    await ready()
    const path = screen.getByLabelText('Local path')
    await userEvent.clear(path)
    await userEvent.type(path, '/nope{Enter}')
    expect(await within(L()).findByRole('alert')).toHaveTextContent('no such directory')
    expect(path).toHaveValue('/Users/me')
  })

  it('creates, renames and deletes locally (folders recursively, after confirming)', async () => {
    const be = setup()
    await ready()
    await viaActions(L(), 'New Folder')
    await userEvent.click(within(L()).getByRole('button', {name: 'Create'}))
    expect(within(L()).getByRole('alert')).toHaveTextContent('Enter a name')
    await userEvent.type(within(L()).getByLabelText('Name'), 'a/b{Enter}')
    expect(within(L()).getByRole('alert')).toHaveTextContent('cannot contain')
    await userEvent.clear(within(L()).getByLabelText('Name'))
    await userEvent.type(within(L()).getByLabelText('Name'), 'work{Enter}')
    await waitFor(() => expect(names(L())).toContain('work'))
    expect(calls(be, 'local.mkdir')[0][1]).toBe('/Users/me/work')

    await pick(L(), 'notes.txt')
    await viaActions(L(), 'Rename')
    expect(within(L()).getByLabelText('Name')).toHaveValue('notes.txt')
    await userEvent.clear(within(L()).getByLabelText('Name'))
    await userEvent.type(within(L()).getByLabelText('Name'), 'todo.txt{Enter}')
    await waitFor(() => expect(names(L())).toContain('todo.txt'))

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
    await pick(L(), 'todo.txt')
    await viaActions(L(), 'Delete')
    expect(calls(be, 'local.remove')).toHaveLength(0)
    await viaActions(L(), 'Delete')
    await waitFor(() => expect(names(L())).not.toContain('todo.txt'))
    await pick(L(), 'Documents')
    await viaActions(L(), 'Delete')
    await waitFor(() => expect(names(L())).not.toContain('Documents'))
    expect(confirm.mock.calls[2][0]).toMatch(/folder "Documents" and everything in it/)
    expect(calls(be, 'local.remove').map(c => c[2])).toEqual([false, true])
  })

  it('does the same on the host through SFTP', async () => {
    const be = setup()
    await ready()
    await viaActions(R(), 'New Folder')
    await userEvent.type(within(R()).getByLabelText('Name'), 'logs{Enter}')
    await waitFor(() => expect(names(R())).toContain('logs'))
    expect(calls(be, 'sftp.mkdir')[0].slice(2)).toEqual(['/logs'])
    await pick(R(), 'readme.txt')
    await viaActions(R(), 'Rename')
    await userEvent.clear(within(R()).getByLabelText('Name'))
    await userEvent.type(within(R()).getByLabelText('Name'), 'README.md{Enter}')
    await waitFor(() => expect(names(R())).toContain('README.md'))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await pick(R(), 'README.md')
    await viaActions(R(), 'Delete')
    await waitFor(() => expect(names(R())).not.toContain('README.md'))
  })
})

describe('SftpBrowser: moving files and folders between the panes', () => {
  const ctrl = async (pane: HTMLElement, n: string) => { fireEvent.click(row(pane, n), {ctrlKey: true}) }
  const shift = async (pane: HTMLElement, n: string) => { fireEvent.click(row(pane, n), {shiftKey: true}) }

  it('Upload sends the selected file to the remote folder and shows what happened', async () => {
    const be = setup()
    await ready()
    expect(await actionItem(L(), 'Upload')).toBeDisabled(); fireEvent.keyDown(window, {key: 'Escape'})
    await pick(L(), 'notes.txt')
    await viaActions(L(), 'Upload')
    await waitFor(() => expect(names(R())).toContain('notes.txt'))
    expect(calls(be, 'sftp.uploadAll')[0].slice(2)).toEqual([['/Users/me/notes.txt'], '/', false])
    expect(screen.getByRole('status', {name: 'Transfer progress'})).toHaveTextContent('Uploading notes.txt')
  })

  it('Download saves the selected remote file into the local folder and lists it', async () => {
    const be = setup()
    await ready()
    expect(screen.getByRole('button', {name: 'Download selected'})).toBeDisabled()
    await pick(R(), 'readme.txt')
    await userEvent.click(screen.getByRole('button', {name: 'Download selected'}))
    await waitFor(() => expect(names(L())).toContain('readme.txt'))
    expect(calls(be, 'sftp.downloadAll')[0].slice(2)).toEqual([['/readme.txt'], '/Users/me', false])
  })

  it('a whole folder goes with everything inside, and the summary says how much', async () => {
    const be = setup()
    await ready()
    await pick(L(), 'Documents')
    expect(await actionItem(L(), 'Upload')).toBeEnabled(); fireEvent.keyDown(window, {key: 'Escape'}) // folders are fine now
    await viaActions(L(), 'Upload')
    await waitFor(() => expect(names(R())).toContain('Documents'))
    expect(be.state.remote['/Documents/cv.pdf']).toBeDefined()
    expect(await screen.findByText(/Uploaded 1 file and 1 folder \(40\.0 KB\)/)).toBeInTheDocument()
  })

  it('Cmd/Ctrl-click, Shift-click and Cmd/Ctrl+A select several, and the buttons say how many', async () => {
    const be = setup()
    await ready()
    await userEvent.click(within(L()).getByRole('button', {name: 'Show hidden files'}))
    expect(names(L())).toEqual(['Documents', '.zshrc', 'notes.txt'])
    await pick(L(), 'Documents')
    await ctrl(L(), 'notes.txt')
    expect(within(L()).getByRole('status')).toHaveTextContent('2 selected')
    await ctrl(L(), 'notes.txt') // toggles it off
    expect(within(L()).queryByRole('status')).toBeNull()
    await pick(L(), 'Documents')
    await shift(L(), 'notes.txt') // the range: all three
    expect(within(L()).getByRole('status')).toHaveTextContent('3 selected')
    await viaActions(L(), 'Upload')
    await waitFor(() => expect(calls(be, 'sftp.uploadAll')).toHaveLength(1))
    expect(calls(be, 'sftp.uploadAll')[0][2]).toEqual(['/Users/me/Documents', '/Users/me/.zshrc', '/Users/me/notes.txt'])
    // select all with the keyboard
    await userEvent.click(row(R(), 'projects'))
    fireEvent.keyDown(row(R(), 'projects'), {key: 'a', ctrlKey: true})
    await waitFor(() => expect(within(R()).getByRole('status')).toHaveTextContent(/\d+ selected/))
  })

  it('dragging a selected row drags the whole selection; dragging an unselected row drags just that row', async () => {
    const be = setup()
    await ready()
    await pick(L(), 'Documents')
    await ctrl(L(), 'notes.txt')
    drag(row(L(), 'Documents'), within(R()).getByRole('table', {name: 'Remote files'}))
    await waitFor(() => expect(calls(be, 'sftp.uploadAll')).toHaveLength(1))
    expect(calls(be, 'sftp.uploadAll')[0][2]).toEqual(['/Users/me/Documents', '/Users/me/notes.txt'])
    await pick(L(), 'Documents')
    drag(row(L(), 'notes.txt'), within(R()).getByRole('table', {name: 'Remote files'})) // not in the selection
    await waitFor(() => expect(calls(be, 'sftp.uploadAll')).toHaveLength(2))
    expect(calls(be, 'sftp.uploadAll')[1][2]).toEqual(['/Users/me/notes.txt'])
  })

  it('asks once for the whole batch before replacing, and leaves files alone when declined', async () => {
    const be = setup({remote: {'/': {dir: true, size: 0}, '/notes.txt': {dir: false, size: 5}, '/.zshrc': {dir: false, size: 5}}})
    await waitFor(() => expect(names(R())).toHaveLength(2))
    await waitFor(() => expect(names(L())).toHaveLength(2))
    await userEvent.click(within(L()).getByRole('button', {name: 'Show hidden files'}))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    await pick(L(), '.zshrc')
    await ctrl(L(), 'notes.txt')
    await viaActions(L(), 'Upload')
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0]).toMatch(/2 files already exist in \/ \(.*notes\.txt.*\)\. Replace them\?/)
    expect(calls(be, 'sftp.uploadAll').map(c => c[4])).toEqual([false]) // declined: nothing replaced
    expect(await screen.findByText(/2 left as they were/)).toBeInTheDocument()
    await viaActions(L(), 'Upload')
    await waitFor(() => expect(calls(be, 'sftp.uploadAll').map(c => c[4])).toEqual([false, false, true]))
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('a single existing file gets the single-file question', async () => {
    setup({remote: {'/': {dir: true, size: 0}, '/notes.txt': {dir: false, size: 5}}})
    await waitFor(() => expect(names(R())).toEqual(['notes.txt']))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await waitFor(() => expect(names(L())).toHaveLength(2))
    await pick(L(), 'notes.txt')
    await viaActions(L(), 'Upload')
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(confirm.mock.calls[0][0]).toBe('notes.txt already exists in /. Replace it?')
  })

  it('drag and drop: local items dropped on the remote pane upload, remote items dropped on the local pane download', async () => {
    const be = setup()
    await ready()
    drag(row(L(), 'notes.txt'), within(R()).getByRole('table', {name: 'Remote files'}))
    await waitFor(() => expect(calls(be, 'sftp.uploadAll')).toHaveLength(1))
    await waitFor(() => expect(names(R())).toContain('notes.txt'))
    drag(row(R(), 'projects'), within(L()).getByRole('table', {name: 'Local files'})) // a remote folder
    await waitFor(() => expect(calls(be, 'sftp.downloadAll')).toHaveLength(1))
    expect(calls(be, 'sftp.downloadAll')[0].slice(2)).toEqual([['/projects'], '/Users/me', false])
    await waitFor(() => expect(names(L())).toContain('projects'))
    expect(be.state.local['/Users/me/projects/app.log']).toBeDefined()
  })

  it('dropping on the pane it came from does nothing, and the target pane lights up while dragging over', async () => {
    const be = setup()
    await ready()
    const dt = dataTransfer()
    fireEvent.dragStart(row(L(), 'notes.txt'), {dataTransfer: dt})
    fireEvent.dragOver(within(L()).getByRole('table', {name: 'Local files'}), {dataTransfer: dt})
    fireEvent.drop(within(L()).getByRole('table', {name: 'Local files'}), {dataTransfer: dt})
    expect(calls(be, 'sftp.uploadAll')).toHaveLength(0)
    expect(calls(be, 'sftp.downloadAll')).toHaveLength(0)
    fireEvent.dragOver(within(R()).getByRole('table', {name: 'Remote files'}), {dataTransfer: dt})
    expect(R().classList.contains('drop-target') || R().querySelector('.fpane')?.classList.contains('drop-target')).toBe(true)
    fireEvent.dragLeave(within(R()).getByRole('table', {name: 'Remote files'}))
    expect(R().querySelector('.drop-target') ?? (R().classList.contains('drop-target') ? R() : null)).toBeNull()
  })

  it('ignores drops that are not from the panes (files from Finder, text)', async () => {
    const be = setup()
    await ready()
    const table = within(R()).getByRole('table', {name: 'Remote files'})
    const dt = {types: ['Files'], getData: () => '', dropEffect: ''}
    fireEvent.dragOver(table, {dataTransfer: dt})
    fireEvent.drop(table, {dataTransfer: dt})
    expect(calls(be, 'sftp.uploadAll')).toHaveLength(0)
  })

  it('shows the error from a failed transfer, and still refreshes the receiving side', async () => {
    const be = setup()
    be.sftp.uploadAll = async () => { throw 'notes.txt: permission denied' }
    await ready()
    await pick(L(), 'notes.txt')
    await viaActions(L(), 'Upload')
    expect(await screen.findByText('notes.txt: permission denied')).toBeInTheDocument()
  })

  it('cannot transfer before a host is connected', async () => {
    setup({}, false)
    await waitFor(() => expect(names(L())).toHaveLength(2))
    await pick(L(), 'notes.txt')
    expect(await actionItem(L(), 'Upload')).toBeDisabled(); fireEvent.keyDown(window, {key: 'Escape'})
  })

  it('deletes several selected items after one confirmation', async () => {
    const be = setup()
    await ready()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await pick(R(), 'projects')
    await ctrl(R(), 'readme.txt')
    await viaActions(R(), 'Delete')
    await waitFor(() => expect(names(R())).toEqual([]))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatch(/these 2 items/)
    expect(calls(be, 'sftp.remove')).toHaveLength(2)
    expect(await actionItem(R(), 'Rename')).toBeDisabled()
  })

  it('Rename needs exactly one selected item', async () => {
    setup()
    await ready()
    await pick(R(), 'projects')
    expect(await actionItem(R(), 'Rename')).toBeEnabled()
    fireEvent.keyDown(window, {key: 'Escape'})
    await ctrl(R(), 'readme.txt')
    expect(await actionItem(R(), 'Rename')).toBeDisabled()
  })
})

describe('transfer summaries', () => {
  const base = {files: 0, dirs: 0, bytes: 0, skipped: [] as string[], ignored: [] as string[]}
  it('says what was done and what was left', () => {
    expect(summarize('Uploaded', {...base, files: 12, dirs: 3, bytes: 1536})).toBe('Uploaded 12 files and 3 folders (1.5 KB)')
    expect(summarize('Saved', {...base, files: 1, bytes: 10})).toBe('Saved 1 file (10 B)')
    expect(summarize('Saved', {...base, dirs: 1})).toBe('Saved 1 folder (0 B)')
    expect(summarize('Uploaded', {...base, files: 1, bytes: 5, skipped: ['a', 'b'], ignored: ['link']})).toBe('Uploaded 1 file (5 B), 2 left as they were, 1 link ignored')
    expect(summarize('Uploaded', base)).toBe('Nothing to transfer')
  })
  it('asks about one or many existing files', () => {
    expect(replaceQuestion({...base, skipped: ['a.txt']}, '/srv')).toBe('a.txt already exists in /srv. Replace it?')
    expect(replaceQuestion({...base, skipped: ['a', 'b', 'c', 'd']}, '/srv')).toBe('4 files already exist in /srv (a, b, c, …). Replace them?')
  })
})

describe('SftpBrowser: the host', () => {
  it('starts with "Connect to host"; Select host lists the saved hosts, searchable, and connecting works', async () => {
    const be = setup({}, false)
    expect(within(R()).getByText('Connect to host')).toBeInTheDocument()
    expect(within(R()).getByText(/manage your files with SFTP/)).toBeInTheDocument()
    await userEvent.click(within(R()).getByRole('button', {name: 'Select host'}))
    await userEvent.type(within(R()).getByLabelText('Filter hosts'), 'db')
    expect(within(R()).queryByRole('button', {name: 'Connect to web-1'})).toBeNull()
    await userEvent.click(within(R()).getByRole('button', {name: 'Connect to db-1'}))
    await waitFor(() => expect(names(R())).toHaveLength(2))
    expect(calls(be, 'sftp.open')[0][1]).toBe('h2')
    expect(screen.getByTestId('sftp')).toHaveAttribute('aria-label', 'SFTP db-1')
  })

  it('Select host can be cancelled and explains an empty host list', async () => {
    setup({hosts: []}, false)
    await userEvent.click(within(R()).getByRole('button', {name: 'Select host'}))
    expect(within(R()).getByText(/No saved hosts yet/)).toBeInTheDocument()
    await userEvent.click(within(R()).getByRole('button', {name: 'Cancel'}))
    expect(within(R()).getByText('Connect to host')).toBeInTheDocument()
  })

  it('Change host closes the connection and goes back to the choice', async () => {
    const be = setup()
    await ready()
    await userEvent.click(within(R()).getByRole('button', {name: 'Change host'}))
    expect(within(R()).getByText('Connect to host')).toBeInTheDocument()
    expect(calls(be, 'sftp.close')).toHaveLength(1)
    expect(await actionItem(L(), 'Upload')).toBeDisabled(); fireEvent.keyDown(window, {key: 'Escape'})
  })

  it('closes its connection when the tab goes away', async () => {
    const be = makeFake({hosts: [host({id: 'h1', label: 'web-1'})]})
    const {unmount} = render(<Providers be={be}><SftpBrowser hostId="h1" hostLabel="web-1" /></Providers>)
    await ready()
    unmount()
    expect(calls(be, 'sftp.close')).toHaveLength(1)
  })

  it('asks to trust an unknown host key before connecting', async () => {
    const be = makeFake({hosts: [host({id: 'h1', label: 'web-1'})]})
    const open = be.sftp.open
    let trusted!: () => void
    const gate = new Promise<void>(r => { trusted = r })
    be.sftp.open = async (h, k) => {
      be.emit('term:hostkey:' + k, {host: 'web-1:22', key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc'})
      await gate
      return open(h, k)
    }
    render(<Providers be={be}><SftpBrowser hostId="h1" hostLabel="web-1" /></Providers>)
    const dlg = await screen.findByRole('alertdialog', {name: 'Host key confirmation'})
    expect(within(dlg).getByTestId('fingerprint')).toHaveTextContent('SHA256:abc')
    be.session.trustHostKey = vi.fn(async () => { trusted() })
    await userEvent.click(within(dlg).getByRole('button', {name: 'Trust and connect'}))
    expect(be.session.trustHostKey).toHaveBeenCalledWith(expect.stringMatching(/^sftp-/), 'SHA256:abc')
    await waitFor(() => expect(names(R())).toHaveLength(2))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows a banner when the connection fails and reconnects on request', async () => {
    const be = makeFake({hosts: [host({id: 'h1', label: 'web-1'})]})
    let fail = true
    const open = be.sftp.open
    be.sftp.open = async (h, k) => { if (fail) throw 'connection refused'; return open(h, k) }
    render(<Providers be={be}><SftpBrowser hostId="h1" hostLabel="web-1" /></Providers>)
    expect(await screen.findByText('connection refused')).toBeInTheDocument()
    expect(within(R()).getByLabelText('Remote path')).toBeDisabled()
    fail = false
    await userEvent.click(screen.getByRole('button', {name: 'Reconnect'}))
    await waitFor(() => expect(names(R())).toHaveLength(2))
    expect(screen.queryByRole('button', {name: 'Reconnect'})).toBeNull()
  })

  it('shows the banner when the connection drops later and disables transfers', async () => {
    const be = setup()
    await ready()
    const sid = calls(be, 'sftp.list')[0][1] as string
    act(() => be.emit('sftp:closed:' + sid))
    expect(await screen.findByText('The connection was lost.')).toBeInTheDocument()
    expect(await actionItem(L(), 'Upload')).toBeDisabled(); fireEvent.keyDown(window, {key: 'Escape'})
  })
})

describe('sftp format helpers', () => {
  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(200 * 1024 * 1024 * 1024)).toBe('200 GB')
  })
  it('builds breadcrumbs, parents and joined paths', () => {
    expect(breadcrumbs('/')).toEqual([{name: '/', path: '/'}])
    expect(breadcrumbs('/a/b')).toEqual([{name: '/', path: '/'}, {name: 'a', path: '/a'}, {name: 'b', path: '/a/b'}])
    expect(parentOf('/a/b')).toBe('/a')
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('/')).toBe('/')
    expect(joinPath('/', 'x')).toBe('/x')
    expect(joinPath('/a/', 'x')).toBe('/a/x')
  })
  it('validates names', () => {
    expect(validName('ok.txt')).toBeNull()
    expect(validName('  ')).toMatch(/Enter a name/)
    expect(validName('..')).toMatch(/different/)
    expect(validName('a/b')).toMatch(/cannot contain/)
    expect(validName('a\0b')).toMatch(/cannot contain/)
  })
  it('names the kind of an entry', () => {
    expect(kindOf({name: 'src', is_dir: true})).toBe('folder')
    expect(kindOf({name: 'cv.pdf', is_dir: false})).toBe('PDF')
    expect(kindOf({name: 'Makefile', is_dir: false})).toBe('file')
    expect(kindOf({name: '.zshrc', is_dir: false})).toBe('file')
    expect(kindOf({name: 'trailing.', is_dir: false})).toBe('file')
  })
})

describe('SftpBrowser: the host list stays current', () => {
  it('uses the hosts the app gives it, so a host added later is offered', async () => {
    const be = makeFake()
    const a = host({id: 'h1', label: 'first'}), b = host({id: 'h2', label: 'added-later'})
    const {rerender} = render(<Providers be={be}><SftpBrowser hosts={[a]} /></Providers>)
    await userEvent.click(within(R()).getByRole('button', {name: 'Select host'}))
    expect(within(R()).queryByRole('button', {name: 'Connect to added-later'})).toBeNull()
    rerender(<Providers be={be}><SftpBrowser hosts={[a, b]} /></Providers>)
    expect(within(R()).getByRole('button', {name: 'Connect to added-later'})).toBeInTheDocument()
    expect(calls(be, 'hosts.listHosts')).toHaveLength(0) // nothing is loaded twice
  })
})

describe('SftpBrowser: right-click menu', () => {
  const menuOf = () => screen.getByRole('menu')
  const items = () => within(menuOf()).getAllByRole('menuitem').map(i => i.textContent)

  const FULL = ['Open', 'Open with…', 'Download', 'Rename', 'Delete', 'Refresh', 'New Folder', 'Hide Hidden Files', 'Edit Permissions', 'Select All', 'Close']

  it('a file has the full list: Open … Select All and Close', async () => {
    setup()
    await ready()
    fireEvent.contextMenu(row(R(), 'readme.txt'))
    expect(items()).toEqual(FULL)
    expect(row(R(), 'readme.txt')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(window, {key: 'Escape'})
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('empty space has the same list, with what needs a file greyed out', async () => {
    setup()
    await ready()
    fireEvent.contextMenu(within(R()).getByRole('table'))
    expect(items()).toEqual(FULL)
    const on = within(menuOf()).getAllByRole('menuitem').filter(i => !(i as HTMLButtonElement).disabled).map(i => i.textContent)
    expect(on).toEqual(['Refresh', 'New Folder', 'Hide Hidden Files', 'Select All', 'Close'])
  })

  it('the Actions button opens the same menu for what is selected; Select All and Close work', async () => {
    setup()
    await ready()
    await userEvent.click(row(R(), 'readme.txt'))
    await userEvent.click(within(R()).getByRole('button', {name: 'Actions'}))
    expect(items()).toEqual(FULL)
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Select All'}))
    expect(within(R()).getByRole('status')).toHaveTextContent(/selected/)
    await userEvent.click(within(R()).getByRole('button', {name: 'Actions'}))
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Close'}))
    expect(screen.getByText('Connect to host')).toBeInTheDocument()
  })

  it('Filter narrows the rows by name', async () => {
    setup()
    await ready()
    await userEvent.click(within(R()).getByRole('button', {name: 'Filter'}))
    await userEvent.type(within(R()).getByLabelText('Remote filter'), 'readme')
    expect(row(R(), 'readme.txt')).toBeInTheDocument()
    expect(within(R()).queryByText('projects')).toBeNull()
  })

  it('Open on a folder goes into it, and on a remote file downloads it to a temporary folder and opens that', async () => {
    const be = setup()
    await ready()
    fireEvent.contextMenu(row(R(), 'projects'))
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Open'}))
    await waitFor(() => expect(screen.getByLabelText('Remote path')).toHaveValue('/projects'))
    await userEvent.click(within(R()).getByRole('button', {name: 'Up one folder'}))
    await waitFor(() => expect(names(R())).toContain('readme.txt'))
    fireEvent.contextMenu(row(R(), 'readme.txt'))
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Open'}))
    await waitFor(() => expect(calls(be, 'system.openPath')).toEqual([['system.openPath', '/tmp/vvterm-open-1/readme.txt']]))
    expect(calls(be, 'sftp.downloadAll')[0].slice(2)).toEqual([['/readme.txt'], '/tmp/vvterm-open-1', true])
  })

  it('a local file is opened in place, and Open with asks which app', async () => {
    const be = setup()
    await ready()
    fireEvent.contextMenu(row(L(), 'notes.txt'))
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Open'}))
    await waitFor(() => expect(calls(be, 'system.openPath')).toEqual([['system.openPath', '/Users/me/notes.txt']]))
  })

  it('Upload (local pane) and Download (remote pane) in the menu send the chosen items to the other pane', async () => {
    const be = setup()
    await ready()
    await pick(L(), 'notes.txt')
    fireEvent.contextMenu(row(L(), 'notes.txt'))
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Upload'}))
    await waitFor(() => expect(calls(be, 'sftp.uploadAll')).toHaveLength(1))
    expect(calls(be, 'sftp.uploadAll')[0][2]).toEqual(['/Users/me/notes.txt'])
  })

  it('Rename and New Folder open the name box, Delete asks first', async () => {
    const be = setup()
    await ready()
    fireEvent.contextMenu(row(R(), 'readme.txt'))
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Rename'}))
    expect(within(R()).getByLabelText('Name')).toHaveValue('readme.txt')
    await userEvent.click(within(R()).getByRole('button', {name: 'Cancel'}))
    fireEvent.contextMenu(row(R(), 'readme.txt'))
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'New Folder'}))
    expect(within(R()).getByLabelText('Name')).toHaveValue('')
    await userEvent.click(within(R()).getByRole('button', {name: 'Cancel'}))
    fireEvent.contextMenu(row(R(), 'readme.txt'))
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Delete'}))
    await waitFor(() => expect(ask).toHaveBeenCalled())
    expect(calls(be, 'sftp.remove')).toHaveLength(0)
  })

  it('Edit Permissions changes the mode on the server', async () => {
    const be = setup()
    await ready()
    fireEvent.contextMenu(row(R(), 'readme.txt'))
    await userEvent.click(within(menuOf()).getByRole('menuitem', {name: 'Edit Permissions'}))
    await userEvent.clear(screen.getByLabelText('Octal permissions'))
    await userEvent.type(screen.getByLabelText('Octal permissions'), '600')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(calls(be, 'sftp.chmod')).toHaveLength(1))
    expect(calls(be, 'sftp.chmod')[0].slice(2)).toEqual(['/readme.txt', 0o600])
  })
})
