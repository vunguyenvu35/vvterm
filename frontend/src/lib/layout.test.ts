import {closePane, hasPane, leaves, newTab, splitPane} from './layout'

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
