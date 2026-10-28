import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {SnippetsPage} from './SnippetsPage'
import {SnippetForm} from './SnippetForm'
import {SnippetPicker} from './SnippetPicker'
import {makeFake, Providers} from '../../test/fakeBackend'
import type {Snippet} from '../types'

const s1: Snippet = {id: 's1', label: 'Docker full clean', script: 'docker stop $(docker ps -aq)\ndocker system prune -af'}
const s2: Snippet = {id: 's2', label: 'Disk', description: 'free space', script: 'df -h'}

describe('SnippetsPage', () => {
  function setup(canRun = true, snippets = [s1, s2]) {
    const cb = {onNew: vi.fn(), onRun: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn()}
    render(<SnippetsPage snippets={snippets} canRun={canRun} {...cb} />)
    return cb
  }

  it('lists snippets with their description or first line', () => {
    setup()
    expect(screen.getByText('Docker full clean')).toBeInTheDocument()
    expect(screen.getByText('docker stop $(docker ps -aq)')).toBeInTheDocument()
    expect(screen.getByText('free space')).toBeInTheDocument()
  })

  it('Run executes, Paste does not, and the other actions are wired', async () => {
    const cb = setup()
    await userEvent.click(screen.getByLabelText('Run Disk'))
    await userEvent.click(screen.getByLabelText('Paste Disk'))
    await userEvent.click(screen.getByLabelText('Edit Disk'))
    await userEvent.click(screen.getByLabelText('Delete Disk'))
    await userEvent.click(screen.getByRole('button', {name: 'New snippet'}))
    expect(cb.onRun.mock.calls).toEqual([[s2, true], [s2, false]])
    expect(cb.onEdit).toHaveBeenCalledWith(s2)
    expect(cb.onDelete).toHaveBeenCalledWith(s2)
    expect(cb.onNew).toHaveBeenCalled()
  })

  it('explains that a terminal is needed, and shows an empty state', () => {
    setup(false)
    expect(screen.getByText(/Open a terminal to run a snippet/)).toBeInTheDocument()
  })

  it('shows the empty hint without snippets', () => {
    setup(true, [])
    expect(screen.getByText(/No snippets yet/)).toBeInTheDocument()
    expect(screen.queryByText(/Open a terminal/)).toBeNull()
  })
})

describe('SnippetForm', () => {
  it('requires a label and a script', async () => {
    const be = makeFake()
    render(<Providers be={be}><SnippetForm onClose={vi.fn()} onSaved={vi.fn()} /></Providers>)
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Label is required')
    await userEvent.type(screen.getByLabelText('Snippet label'), 'x')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('Script is required')
    expect(be.state.calls.some(c => c[0] === 'snippets.save')).toBe(false)
  })

  it('saves a multi-line script exactly as typed', async () => {
    const be = makeFake()
    const onSaved = vi.fn()
    render(<Providers be={be}><SnippetForm onClose={vi.fn()} onSaved={onSaved} /></Providers>)
    await userEvent.type(screen.getByLabelText('Snippet label'), '  Clean  ')
    await userEvent.type(screen.getByLabelText('Script'), 'echo one{Enter}echo two')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(be.state.snippets[0]).toMatchObject({label: 'Clean', script: 'echo one\necho two'})
  })

  it('prefills when editing and updates the same record', async () => {
    const be = makeFake({snippets: [s2]})
    render(<Providers be={be}><SnippetForm snippet={s2} onClose={vi.fn()} onSaved={vi.fn()} /></Providers>)
    expect(screen.getByLabelText('Snippet label')).toHaveValue('Disk')
    await userEvent.type(screen.getByLabelText('Script'), ' /')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(be.state.snippets).toHaveLength(1))
    expect(be.state.snippets[0]).toMatchObject({id: 's2', script: 'df -h /'})
  })

  it('shows backend errors', async () => {
    const be = makeFake()
    be.snippets.save = async () => { throw 'snippet script must not contain NUL characters' }
    render(<Providers be={be}><SnippetForm onClose={vi.fn()} onSaved={vi.fn()} /></Providers>)
    await userEvent.type(screen.getByLabelText('Snippet label'), 'x')
    await userEvent.type(screen.getByLabelText('Script'), 'ls')
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('NUL')
  })
})

describe('SnippetPicker', () => {
  it('is disabled outside a terminal', () => {
    render(<SnippetPicker snippets={[s1]} disabled onRun={vi.fn()} />)
    expect(screen.getByRole('button', {name: 'Run snippet'})).toBeDisabled()
  })

  it('runs or pastes the chosen snippet and closes', async () => {
    const onRun = vi.fn()
    render(<SnippetPicker snippets={[s1, s2]} disabled={false} onRun={onRun} />)
    await userEvent.click(screen.getByRole('button', {name: 'Run snippet'}))
    await userEvent.click(screen.getByRole('button', {name: /^Disk/}))
    expect(onRun).toHaveBeenCalledWith(s2, true)
    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: 'Run snippet'}))
    await userEvent.click(screen.getByLabelText('Paste Docker full clean without Enter'))
    expect(onRun).toHaveBeenLastCalledWith(s1, false)
  })

  it('closes on Escape and on outside click, and tells when there are none', async () => {
    render(<div><SnippetPicker snippets={[]} disabled={false} onRun={vi.fn()} /><span>outside</span></div>)
    await userEvent.click(screen.getByRole('button', {name: 'Run snippet'}))
    expect(screen.getByText('No snippets yet')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: 'Run snippet'}))
    await userEvent.click(screen.getByText('outside'))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
