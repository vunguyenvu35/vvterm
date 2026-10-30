import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {TerminalSidebar} from '../terminal/Sidebar'
import {DEFAULT_SETTINGS} from '../settings/defaults'
import {host, makeFake, Providers} from '../../test/fakeBackend'

type Fake = ReturnType<typeof makeFake>
const web = host({id: 'h1', label: 'web-1', hostname: 'w1.example.com'})
const calls = (be: Fake, n: string) => be.state.calls.filter(c => c[0] === n)

function setup(hostId: string | undefined, init: Parameters<typeof makeFake>[0] = {}) {
  const be = makeFake({hosts: [web], ...init})
  const view = render(
    <Providers be={be}>
      <TerminalSidebar tab="files" hostId={hostId} hosts={[web]} snippets={[]} settings={DEFAULT_SETTINGS} appearance="dark" onTab={vi.fn()} onInsert={vi.fn()} />
    </Providers>)
  return {be, ...view}
}
const files = () => screen.getByRole('listbox', {name: 'Files'})
const names = () => within(files()).queryAllByRole('option').map(o => within(o).getByText(/./, {selector: 'b'}).textContent)

describe('terminal sidebar: Files', () => {
  it('is a section of the sidebar', () => {
    setup('h1')
    expect(screen.getByRole('button', {name: 'Files (SFTP)'})).toHaveAttribute('aria-pressed', 'true')
  })

  it('explains itself when the focused terminal is not a saved SSH host, and opens no connection', () => {
    const {be} = setup('local')
    expect(screen.getByText(/Focus one to browse its files/)).toBeInTheDocument()
    expect(calls(be, 'sftp.open')).toHaveLength(0)
  })

  it('connects to the focused terminal\'s host and lists its home folder, folders first, hidden files off', async () => {
    const be = setup('h1').be
    await waitFor(() => expect(names()).toEqual(['projects', 'readme.txt']))
    expect(calls(be, 'sftp.open')[0][1]).toBe('h1')
    expect(screen.getByLabelText('Current folder')).toHaveTextContent('/')
  })

  it('opens a folder with a double click, and Up goes back', async () => {
    setup('h1')
    await waitFor(() => expect(names()).toHaveLength(2))
    await userEvent.dblClick(within(files()).getByRole('option', {name: /projects/}))
    await waitFor(() => expect(names()).toEqual(['app.log']))
    expect(screen.getByLabelText('Current folder')).toHaveTextContent('/projects')
    await userEvent.click(screen.getByRole('button', {name: 'Up one folder'}))
    await waitFor(() => expect(names()).toEqual(['projects', 'readme.txt']))
  })

  it('Upload file… queues the picked file into the open folder and the list shows it when done', async () => {
    const {be} = setup('h1', {local: {'/': {dir: true, size: 0}, '/tmp': {dir: true, size: 0}, '/tmp/picked': {dir: false, size: 77}}})
    await waitFor(() => expect(names()).toHaveLength(2))
    await userEvent.click(screen.getByRole('button', {name: 'Upload file…'}))
    await waitFor(() => expect(calls(be, 'sftp.enqueue')).toHaveLength(1))
    expect(calls(be, 'sftp.enqueue')[0][2]).toEqual({direction: 'upload', sources: ['/tmp/picked'], destDir: '/', overwrite: false})
    await waitFor(() => expect(names()).toContain('picked'))
    expect(within(screen.getByRole('region', {name: 'Transfers'})).getByRole('listitem', {name: 'picked'})).toHaveTextContent('Done')
  })

  it('Upload folder… picks a folder, and asks once before replacing what exists', async () => {
    const {be} = setup('h1', {remote: {'/': {dir: true, size: 0}, '/dir': {dir: true, size: 0}, '/dir/a.txt': {dir: false, size: 1}},
      local: {'/': {dir: true, size: 0}, '/tmp': {dir: true, size: 0}, '/tmp/dir': {dir: true, size: 0}, '/tmp/dir/a.txt': {dir: false, size: 9}}})
    await waitFor(() => expect(names()).toEqual(['dir']))
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', {name: 'Upload folder…'}))
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1))
    expect(ask.mock.calls[0][0]).toBe('dir/a.txt already exists in /. Replace it?')
    await waitFor(() => expect(calls(be, 'sftp.enqueue')).toHaveLength(1))
    expect(calls(be, 'sftp.enqueue')[0][2]).toMatchObject({direction: 'upload', overwrite: true})
    await waitFor(() => expect(be.state.remote['/dir/a.txt'].size).toBe(9))
  })

  it('Download saves the selected items into a folder the user picks', async () => {
    const be = setup('h1').be
    await waitFor(() => expect(names()).toHaveLength(2))
    expect(screen.getByRole('button', {name: 'Download selected files'})).toBeDisabled()
    await userEvent.click(within(files()).getByRole('option', {name: /readme\.txt/}))
    fireEvent.click(within(files()).getByRole('option', {name: /projects/}), {ctrlKey: true})
    expect(screen.getByRole('button', {name: 'Download selected files'})).toHaveTextContent('Download 2')
    await userEvent.click(screen.getByRole('button', {name: 'Download selected files'}))
    await waitFor(() => expect(calls(be, 'sftp.enqueue')).toHaveLength(1))
    expect(calls(be, 'sftp.enqueue')[0][2]).toEqual({direction: 'download', sources: ['/projects', '/readme.txt'], destDir: '/tmp/dir', overwrite: false})
  })

  it('shows the transfer with its buttons, in the sidebar too', async () => {
    const {be} = setup('h1', {holdQueue: true, local: {'/': {dir: true, size: 0}, '/tmp': {dir: true, size: 0}, '/tmp/picked': {dir: false, size: 77}}})
    await waitFor(() => expect(names()).toHaveLength(2))
    await userEvent.click(screen.getByRole('button', {name: 'Upload file…'}))
    const job = await screen.findByRole('listitem', {name: 'picked'})
    expect(job).toHaveTextContent('Uploading · 40%')
    await userEvent.click(within(job).getByRole('button', {name: 'Pause picked'}))
    await waitFor(() => expect(calls(be, 'sftp.pause')).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('listitem', {name: 'picked'})).toHaveTextContent('Paused'))
  })

  it('closes its connection when the section goes away, and offers Reconnect when the connection is lost', async () => {
    const {be, unmount} = setup('h1')
    await waitFor(() => expect(names()).toHaveLength(2))
    const sid = calls(be, 'sftp.list')[0][1] as string
    act(() => be.emit('sftp:closed:' + sid))
    expect(await screen.findByRole('alert')).toHaveTextContent('The connection was lost.')
    await userEvent.click(screen.getByRole('button', {name: 'Reconnect'}))
    await waitFor(() => expect(calls(be, 'sftp.open')).toHaveLength(2))
    await waitFor(() => expect(names()).toHaveLength(2))
    unmount()
    expect(calls(be, 'sftp.close').length).toBeGreaterThan(0)
  })
})
