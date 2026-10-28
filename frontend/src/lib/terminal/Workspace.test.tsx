import {render} from '@testing-library/react'
import {host} from '../../test/fakeBackend'
import {DEFAULT_SETTINGS} from '../settings/defaults'
import {newTab} from '../layout'
import type {ITheme} from '@xterm/xterm'

const seen: Array<{hostId: string; bg?: string}> = []
vi.mock('./TerminalPane', () => ({
  TerminalPane: (p: {hostId: string; termTheme: ITheme}) => { seen.push({hostId: p.hostId, bg: p.termTheme.background}); return <div data-testid="pane" /> },
}))
vi.mock('../sftp/SftpBrowser', () => ({SftpBrowser: () => <div />}))

import {Workspace} from './Workspace'
import {findTheme} from './themes'

const base = {activeTab: '', settings: {...DEFAULT_SETTINGS, terminal_theme: 'nord'}, appearance: 'dark' as const, shortcuts: {}, onFocusPane: vi.fn(), onPaneExit: vi.fn(), onClosePane: vi.fn()}

describe('Workspace: per-host terminal theme', () => {
  beforeEach(() => { seen.length = 0 })
  const bg = (id: string) => findTheme(id)!.theme.background

  it('a host with its own theme uses it; the others follow Settings', () => {
    render(<Workspace {...base} tabs={[newTab('h1', 'a'), newTab('h2', 'b')]} hosts={[host({id: 'h1', terminal_theme: 'dracula'} as never), host({id: 'h2'})]} />)
    expect(seen.find(s => s.hostId === 'h1')!.bg).toBe(bg('dracula'))
    expect(seen.find(s => s.hostId === 'h2')!.bg).toBe(bg('nord'))
  })

  it('a Telnet pane of the host uses the same theme, and a local terminal follows Settings', () => {
    render(<Workspace {...base} tabs={[newTab('telnet:h1', 'a'), newTab('local', 'b')]} hosts={[host({id: 'h1', terminal_theme: 'dracula'} as never)]} />)
    expect(seen.find(s => s.hostId === 'telnet:h1')!.bg).toBe(bg('dracula'))
    expect(seen.find(s => s.hostId === 'local')!.bg).toBe(bg('nord'))
  })

  it('an unknown theme id falls back to the app appearance rather than breaking', () => {
    render(<Workspace {...base} tabs={[newTab('h1', 'a')]} hosts={[host({id: 'h1', terminal_theme: 'removed-theme'} as never)]} />)
    expect(seen[0].bg).toBe(bg('vvterm-dark'))
  })

  it('works without a host list', () => {
    render(<Workspace {...base} tabs={[newTab('h1', 'a')]} />)
    expect(seen[0].bg).toBe(bg('nord'))
  })
})
