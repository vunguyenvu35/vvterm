import {act, render, screen} from '@testing-library/react'
import {TabStatus} from './TabStatus'
import {setPaneStatus, summarizeStatus} from '../terminal/panes'
import {newSftpTab, newTab, splitPane} from '../layout'

afterEach(() => { ['a', 'b', 'p1', 'p2'].forEach(i => setPaneStatus(i, null)) })

describe('pane status', () => {
  it('summarises panes: connecting wins, closed only when all are, nothing when unknown', () => {
    expect(summarizeStatus(['a', 'b'])).toBeNull()
    setPaneStatus('a', 'ready')
    expect(summarizeStatus(['a', 'b'])).toBe('ready')
    setPaneStatus('b', 'closed')
    expect(summarizeStatus(['a', 'b'])).toBe('ready')
    setPaneStatus('a', 'closed')
    expect(summarizeStatus(['a', 'b'])).toBe('closed')
    setPaneStatus('b', 'connecting')
    expect(summarizeStatus(['a', 'b'])).toBe('connecting')
  })
})

describe('TabStatus', () => {
  it('shows a spinner while connecting, a green dot when connected and a red dot when disconnected', () => {
    const tab = newTab('h1', 'web')
    const id = tab.activePane
    render(<TabStatus tab={tab} />)
    expect(screen.queryByRole('img')).toBeNull()
    act(() => setPaneStatus(id, 'connecting'))
    expect(screen.getByRole('img', {name: 'Connecting'})).toBeInTheDocument()
    act(() => setPaneStatus(id, 'ready'))
    expect(screen.getByRole('img', {name: 'Connected'})).toBeInTheDocument()
    act(() => setPaneStatus(id, 'closed'))
    expect(screen.getByRole('img', {name: 'Disconnected'})).toBeInTheDocument()
    act(() => setPaneStatus(id, null))
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('a split tab is connecting while one of its panes is', () => {
    const tab = splitPane(newTab('h1', 'web'), newTab('h1', 'x').activePane, 'row')
    const ids = [tab.activePane]
    render(<TabStatus tab={tab} />)
    ids.forEach(i => act(() => setPaneStatus(i, 'closed')))
    expect(screen.getByRole('img', {name: 'Disconnected'})).toBeInTheDocument()
  })

  it('a file browser tab and a tab still choosing a protocol have none', () => {
    const sftp = newSftpTab('h1', 'SFTP')
    act(() => setPaneStatus(sftp.activePane, 'closed'))
    const {container} = render(<TabStatus tab={sftp} />)
    expect(container).toBeEmptyDOMElement()
    const choosing = {...newTab('h1', 'web'), choose: true}
    act(() => setPaneStatus(choosing.activePane, 'closed'))
    const r = render(<TabStatus tab={choosing} />)
    expect(r.container).toBeEmptyDOMElement()
    setPaneStatus(sftp.activePane, null)
    setPaneStatus(choosing.activePane, null)
  })
})
