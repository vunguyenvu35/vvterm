import {closePane, hasPane, leaves, moveTab, movePane, newTab, pinnedSftpTab, splitPane} from './layout'

describe('pane layout', () => {
  it('starts with one leaf', () => {
    const t = newTab('h1', 'web')
    expect(leaves(t.root)).toHaveLength(1)
    expect(t.activePane).toBe(leaves(t.root)[0].id)
  })

  it('splits a pane, focuses the new one, and keeps the host', () => {
    let t = newTab('h1', 'web')
    const first = t.activePane
    t = splitPane(t, first, 'row')
    const ls = leaves(t.root)
    expect(ls).toHaveLength(2)
    expect(ls.every(l => l.hostId === 'h1')).toBe(true)
    expect(t.activePane).not.toBe(first)
    expect(t.root.type === 'split' && t.root.dir).toBe('row')
  })

  it('supports nested splits in both directions', () => {
    let t = newTab('h', 'x')
    t = splitPane(t, t.activePane, 'row')
    t = splitPane(t, t.activePane, 'col')
    expect(leaves(t.root)).toHaveLength(3)
  })

  it('ignores a split of an unknown pane', () => {
    const t = newTab('h', 'x')
    expect(splitPane(t, 'nope', 'row')).toBe(t)
  })

  it('closing a pane promotes its sibling and fixes focus', () => {
    let t = newTab('h', 'x')
    const a = t.activePane
    t = splitPane(t, a, 'row')
    const b = t.activePane
    const after = closePane(t, b)!
    expect(after.root.type).toBe('leaf')
    expect(after.activePane).toBe(a)
    expect(hasPane(after, b)).toBe(false)
  })

  it('closing the last pane returns null', () => {
    const t = newTab('h', 'x')
    expect(closePane(t, t.activePane)).toBeNull()
  })

  it('keeps focus when an unfocused pane closes', () => {
    let t = newTab('h', 'x')
    const a = t.activePane
    t = splitPane(t, a, 'row')
    const b = t.activePane
    const after = closePane(t, a)!
    expect(after.activePane).toBe(b)
  })
})

describe('sftp tabs', () => {
  it('are tabs of kind sftp with a single leaf for the host', async () => {
    const {newSftpTab, isSftp} = await import('./layout')
    const t = newSftpTab('h1', 'web · SFTP')
    expect(isSftp(t)).toBe(true)
    expect(isSftp(newTab('h1', 'web'))).toBe(false)
    expect(leaves(t.root)).toHaveLength(1)
  })

  it('cannot be split', async () => {
    const {newSftpTab} = await import('./layout')
    const t = newSftpTab('h1', 'x')
    expect(splitPane(t, t.activePane, 'row')).toBe(t)
  })
})

describe('uniqueTitle', () => {
  it('keeps a free name, and numbers a taken one with the lowest free number', async () => {
    const {uniqueTitle} = await import('./layout')
    expect(uniqueTitle([], 'web')).toBe('web')
    expect(uniqueTitle([{title: 'db'}], 'web')).toBe('web')
    expect(uniqueTitle([{title: 'web'}], 'web')).toBe('web (2)')
    expect(uniqueTitle([{title: 'web'}, {title: 'web (2)'}], 'web')).toBe('web (3)')
    expect(uniqueTitle([{title: 'web'}, {title: 'web (3)'}], 'web')).toBe('web (2)') // a closed tab frees its number
    expect(uniqueTitle([{title: 'web (2)'}], 'web')).toBe('web')
  })
})

describe('broadcast, zoom and duplicate', () => {
  const two = async () => {
    const m = await import('./layout')
    let t = m.newTab('h1', 'web')
    t = m.splitPane(t, t.activePane, 'row')
    return {m, t, ids: m.leaves(t.root).map(l => l.id)}
  }

  it('broadcast needs two panes, toggles, and goes away when one pane is left', async () => {
    const {m, t, ids} = await two()
    expect(m.toggleBroadcast(m.newTab('h', 'x')).broadcast).toBeUndefined()
    const on = m.toggleBroadcast(t)
    expect(on.broadcast).toBe(true)
    expect(m.toggleBroadcast(on).broadcast).toBe(false)
    const left = m.closePane(on, ids[0])!
    expect(left.broadcast).toBeUndefined()
  })

  it('zoom shows one pane, toggles back, ignores a pane that is not there, and a new split leaves the zoom', async () => {
    const {m, t, ids} = await two()
    const z = m.toggleZoom(t, ids[0])
    expect(z.zoomPane).toBe(ids[0])
    expect(z.activePane).toBe(ids[0])
    expect(m.toggleZoom(z, ids[0]).zoomPane).toBeUndefined()
    expect(m.toggleZoom(t, 'nope')).toBe(t)
    expect(m.toggleZoom(m.newTab('h', 'x'), 'p')).toBeDefined()
    expect(m.splitPane(z, ids[0], 'col').zoomPane).toBeUndefined()
  })

  it('closing the zoomed pane leaves the zoom; closing another keeps it', async () => {
    const {m, t, ids} = await two()
    let three = m.splitPane(t, ids[1], 'col')
    const [a, b, c] = m.leaves(three.root).map(l => l.id)
    three = m.toggleZoom(three, a)
    expect(m.closePane(three, b)!.zoomPane).toBe(a)
    expect(m.closePane(three, a)!.zoomPane).toBeUndefined()
    expect(c).toBeTruthy()
  })

  it('duplicate makes a new tab on the focused pane\'s host, but not for a file browser', async () => {
    const {m, t} = await two()
    const d = m.duplicateOf(t, 'web (2)')!
    expect(d.title).toBe('web (2)')
    expect(m.leaves(d.root)[0].hostId).toBe('h1')
    expect(d.id).not.toBe(t.id)
    expect(m.duplicateOf(m.pinnedSftpTab(), 'x')).toBeNull()
  })
})

describe('moveTab', () => {
  const mk = () => [{...pinnedSftpTab()}, {...newTab('a', 'A'), id: 'a'}, {...newTab('b', 'B'), id: 'b'}, {...newTab('c', 'C'), id: 'c'}]
  const ids = (ts: {id: string}[]) => ts.map(t => t.id)

  it('puts a tab before or after another one', () => {
    expect(ids(moveTab(mk(), 'c', 'a'))).toEqual(['sftp-main', 'c', 'a', 'b'])
    expect(ids(moveTab(mk(), 'a', 'c', true))).toEqual(['sftp-main', 'b', 'c', 'a'])
    expect(ids(moveTab(mk(), 'a', 'b', true))).toEqual(['sftp-main', 'b', 'a', 'c'])
  })
  it('never moves the pinned tab, and nothing goes before it', () => {
    expect(ids(moveTab(mk(), 'sftp-main', 'c', true))).toEqual(ids(mk()))
    expect(ids(moveTab(mk(), 'c', 'sftp-main'))).toEqual(['sftp-main', 'c', 'a', 'b'])
  })
  it('changes nothing for an unknown tab or a move onto itself', () => {
    const t = mk()
    expect(moveTab(t, 'x', 'a')).toBe(t)
    expect(moveTab(t, 'a', 'x')).toBe(t)
    expect(moveTab(t, 'a', 'a')).toBe(t)
  })
})

describe('movePane (a pane dragged by its header)', () => {
  const two = () => {
    const t = {...newTab('h1', 'web'), id: 'tw'}
    const first = t.activePane
    const split = splitPane(t, first, 'col')
    return {tab: split, first, second: split.activePane}
  }
  const ids = (t: {root: Parameters<typeof leaves>[0]}) => leaves(t.root).map(l => l.id)

  it('puts a pane on a side of another pane of the same tab, keeping its id (its session goes on)', () => {
    const {tab, first, second} = two()
    const third = splitPane(tab, second, 'row')
    const c = third.activePane
    const out = movePane([third], third.id, c, third.id, first, 'left')!
    expect(out).toHaveLength(1)
    expect(ids(out[0])).toEqual([c, first, second]) // c is now to the left of the first pane
    expect(out[0].activePane).toBe(c)
    expect(leaves(out[0].root).find(l => l.id === c)!.hostId).toBe('h1')
  })

  it('moves a pane to another tab, which gets it as a split; the tab it left keeps its other panes', () => {
    const {tab, first, second} = two()
    const other = {...newTab('h2', 'db'), id: 'tb'}
    const out = movePane([tab, other], tab.id, second, other.id, other.activePane, 'right')!
    expect(ids(out.find(t => t.id === 'tw')!)).toEqual([first])
    expect(ids(out.find(t => t.id === 'tb')!)).toEqual([other.activePane, second])
    expect(out.find(t => t.id === 'tb')!.activePane).toBe(second)
  })

  it('a tab whose only pane is moved away is gone', () => {
    const lone = {...newTab('h1', 'one'), id: 'tl'}
    const other = {...newTab('h2', 'db'), id: 'tb'}
    const out = movePane([lone, other], lone.id, lone.activePane, other.id, other.activePane, 'bottom')!
    expect(out.map(t => t.id)).toEqual(['tb'])
    expect(ids(out[0])).toEqual([other.activePane, lone.activePane])
  })

  it('changes nothing for a pane onto itself, an unknown pane, the only pane onto its own tab, or a tab that is not a terminal', () => {
    const {tab, first} = two()
    const lone = {...newTab('h1', 'one'), id: 'tl'}
    expect(movePane([tab], tab.id, first, tab.id, first, 'left')).toBeNull()
    expect(movePane([tab], tab.id, 'nope', tab.id, first, 'left')).toBeNull()
    expect(movePane([tab], tab.id, first, tab.id, 'nope', 'left')).toBeNull()
    expect(movePane([lone], lone.id, lone.activePane, lone.id, lone.activePane, 'left')).toBeNull()
    expect(movePane([tab, pinnedSftpTab()], tab.id, first, 'sftp-main', 'x', 'left')).toBeNull()
  })

  it('leaves the zoomed view, and a tab left with one pane has no broadcast', () => {
    const {tab, second} = two()
    const other = {...newTab('h2', 'db'), id: 'tb'}
    const zoomed = {...tab, broadcast: true, zoomPane: second}
    const out = movePane([zoomed, other], zoomed.id, second, other.id, other.activePane, 'left')!
    expect(out.find(t => t.id === 'tw')!.broadcast).toBeUndefined()
    expect(out.find(t => t.id === 'tw')!.zoomPane).toBeUndefined()
    expect(out.find(t => t.id === 'tb')!.zoomPane).toBeUndefined()
  })
})
