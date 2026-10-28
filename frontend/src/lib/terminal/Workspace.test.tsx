import {createEvent, fireEvent, render} from '@testing-library/react'
import {host} from '../../test/fakeBackend'
import {DEFAULT_SETTINGS} from '../settings/defaults'
import {graftTab, hasPane, leaves, newTab, paneRects, popPane, setDraggingTab, sideOf, splitPane, TAB_DRAG} from '../layout'
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

describe('Workspace: a tab dragged onto a pane', () => {
  beforeEach(() => { seen.length = 0; setDraggingTab('') })
  afterEach(() => setDraggingTab(''))
  const dt = () => {
    const data: Record<string, string> = {}
    return {data, types: [] as string[], effectAllowed: '', dropEffect: '', setData(k: string, v: string) { data[k] = v; this.types = [k] }, getData: (k: string) => data[k]}
  }
  const rect = {left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON() {}}
  const over = (kind: 'dragOver' | 'drop', el: Element, d: unknown, x: number, y: number) => {
    const e = createEvent[kind](el, {dataTransfer: d})
    Object.defineProperty(e, 'clientX', {value: x})
    Object.defineProperty(e, 'clientY', {value: y})
    fireEvent(el, e)
  }

  it('lights up the side it is nearest to and tells the app where the split goes when dropped', () => {
    const target = {...newTab('h1', 'web'), id: 't1'}, other = {...newTab('h2', 'db'), id: 't2'}
    const onDropTab = vi.fn()
    const {container} = render(<Workspace {...base} tabs={[target, other]} activeTab="t1" onDropTab={onDropTab} />)
    const wrap = container.querySelector(`[data-pane="${target.activePane}"]`)!
    Object.defineProperty(wrap, 'getBoundingClientRect', {value: () => rect})
    const t = dt()
    t.setData(TAB_DRAG, 't2')
    setDraggingTab('t2')
    over('dragOver', wrap, t, 380, 100)
    expect(container.querySelector('.drop-hint')).toHaveAttribute('data-side', 'right')
    over('dragOver', wrap, t, 200, 190)
    expect(container.querySelector('.drop-hint')).toHaveAttribute('data-side', 'bottom')
    over('drop', wrap, t, 20, 100)
    expect(onDropTab).toHaveBeenCalledWith('t1', target.activePane, 't2', 'left')
    expect(container.querySelector('.drop-hint')).toBeNull()
  })

  it('shows nothing for a tab dropped on itself, or when nothing is being dragged', () => {
    const target = {...newTab('h1', 'web'), id: 't1'}
    const onDropTab = vi.fn()
    const {container} = render(<Workspace {...base} tabs={[target]} activeTab="t1" onDropTab={onDropTab} />)
    const wrap = container.querySelector(`[data-pane="${target.activePane}"]`)!
    Object.defineProperty(wrap, 'getBoundingClientRect', {value: () => rect})
    const t = dt()
    t.setData(TAB_DRAG, 't1')
    over('dragOver', wrap, t, 380, 100)
    expect(container.querySelector('.drop-hint')).toBeNull()
    setDraggingTab('t1')
    over('dragOver', wrap, t, 380, 100)
    expect(container.querySelector('.drop-hint')).toBeNull()
    over('drop', wrap, t, 380, 100)
    expect(onDropTab).not.toHaveBeenCalled()
  })
})

describe('graftTab and sideOf', () => {
  it('joins the dropped tab as a split on the chosen side, with new panes and the focus on them', () => {
    const target = {...newTab('h1', 'web'), id: 't1'}
    const source = splitPane({...newTab('h2', 'db'), id: 't2'}, newTab('x', 'x').activePane, 'row') // not a pane of it: unchanged
    const right = graftTab(target, target.activePane, source, 'right')
    expect(right.root.type).toBe('split')
    if (right.root.type === 'split') { expect(right.root.dir).toBe('row'); expect(right.root.a).toEqual(target.root) }
    expect(leaves(right.root).map(l => l.hostId)).toEqual(['h1', 'h2'])
    expect(hasPane(right, right.activePane)).toBe(true)
    expect(right.activePane).not.toBe(target.activePane)
    expect(leaves(right.root)[1].id).toBe(source.root.type === 'leaf' ? source.root.id : leaves(source.root)[0].id)
    const top = graftTab(target, target.activePane, {...newTab('h2', 'db'), id: 't2'}, 'top')
    if (top.root.type === 'split') { expect(top.root.dir).toBe('col'); expect(top.root.b).toEqual(target.root) }
    expect(leaves(top.root).map(l => l.hostId)).toEqual(['h2', 'h1'])
  })
  it('a tab with several panes brings them all, the very same panes (no new sessions); wrong cases change nothing', () => {
    const target = {...newTab('h1', 'web'), id: 't1'}
    const src = splitPane({...newTab('h2', 'db'), id: 't2'}, leaves(newTab('h2', 'db').root)[0].id, 'row')
    const two = {...newTab('h2', 'db'), id: 't2'}
    const both = splitPane(two, two.activePane, 'col')
    const joined = graftTab(target, target.activePane, both, 'left')
    expect(leaves(joined.root)).toHaveLength(3)
    expect(leaves(both.root).every(l => leaves(joined.root).some(x => x.id === l.id))).toBe(true) // the same ids: the sessions go on
    expect(graftTab(target, target.activePane, target, 'right')).toBe(target)
    expect(graftTab(target, 'nope', both, 'right')).toBe(target)
    expect(graftTab(target, target.activePane, {...both, kind: 'sftp'}, 'right')).toBe(target)
    void src
  })
  it('sideOf picks the nearest edge', () => {
    expect(sideOf(5, 100, 400, 200)).toBe('left')
    expect(sideOf(395, 100, 400, 200)).toBe('right')
    expect(sideOf(200, 3, 400, 200)).toBe('top')
    expect(sideOf(200, 199, 400, 200)).toBe('bottom')
  })
})

describe('popPane', () => {
  it('takes a pane out of a split into a tab of its own, keeping its id', () => {
    const tab = {...newTab('h1', 'web'), id: 't1'}
    const split = splitPane(tab, tab.activePane, 'row')
    const second = leaves(split.root)[1]
    const res = popPane(split, second.id, 'web (2)')!
    expect(res.popped.root).toEqual(second)
    expect(res.popped.title).toBe('web (2)')
    expect(leaves(res.rest.root).map(l => l.id)).toEqual([tab.activePane])
    expect(res.rest.id).toBe('t1')
    expect(popPane(tab, tab.activePane, 'x')).toBeNull() // the only pane stays
    expect(popPane(split, 'nope', 'x')).toBeNull()
  })
  it('paneRects halves the area at every split', () => {
    const tab = {...newTab('h1', 'web'), id: 't1'}
    const row = splitPane(tab, tab.activePane, 'row')
    const {panes, dividers} = paneRects(row.root)
    expect(Array.from(panes.values())).toEqual([{x: 0, y: 0, w: 50, h: 100}, {x: 50, y: 0, w: 50, h: 100}])
    expect(dividers).toEqual([{x: 50, y: 0, w: 0, h: 100, dir: 'row'}])
    const col = splitPane(row, leaves(row.root)[1].id, 'col')
    expect(Array.from(paneRects(col.root).panes.values()).map(r => [r.x, r.y, r.w, r.h])).toEqual([[0, 0, 50, 100], [50, 0, 50, 50], [50, 50, 50, 50]])
  })
})
