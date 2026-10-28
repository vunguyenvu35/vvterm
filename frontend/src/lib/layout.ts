/** Pure tab / split-pane model. A tab owns a binary tree of panes; each leaf is one SSH session. */
export type Dir = 'row' | 'col'

export interface Leaf {
  type: 'leaf'
  id: string
  hostId: string
}

export interface Split {
  type: 'split'
  id: string
  dir: Dir
  a: Node
  b: Node
}

export type Node = Leaf | Split

export type TabKind = 'terminal' | 'sftp' | 'new'

export interface Tab {
  id: string
  title: string
  root: Node
  activePane: string
  /** terminal (default) or an SFTP file browser; an SFTP tab has a single leaf that only carries the host id */
  kind?: TabKind
  /** a permanent tab (the SFTP tab next to Vaults): no close button, never removed */
  pinned?: boolean
  /** SFTP tab: the host a host card asked to browse, and a counter that makes asking again for the same host count */
  sftpLabel?: string
  sftpNonce?: number
  /** a host with more than one protocol: the tab first asks which one to use (SSH or Telnet) */
  choose?: boolean
  /** what is typed in one pane of this tab is typed in all of them */
  broadcast?: boolean
  /** a pane shown alone, filling the tab (the others keep running behind it) */
  zoomPane?: string
}

let counter = 0
export const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`

export function newTab(hostId: string, title: string): Tab {
  const leaf: Leaf = {type: 'leaf', id: uid('pane'), hostId}
  return {id: uid('tab'), title, root: leaf, activePane: leaf.id}
}

export function newSftpTab(hostId: string, title: string): Tab {
  return {...newTab(hostId, title), kind: 'sftp'}
}

/** Id of the SFTP tab that is always open next to Vaults. */
export const SFTP_TAB_ID = 'sftp-main'

export function pinnedSftpTab(): Tab {
  return {...newSftpTab('', 'SFTP'), id: SFTP_TAB_ID, pinned: true}
}

/** A name no other tab has: "web", then "web (2)", "web (3)"… the lowest number that is free. */
export function uniqueTitle(tabs: Pick<Tab, 'title'>[], wanted: string): string {
  const taken = new Set(tabs.map(t => t.title))
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n++) if (!taken.has(`${wanted} (${n})`)) return `${wanted} (${n})`
}

/** The longest name a tab can be given. */
export const MAX_TAB_TITLE = 60

export const isSftp = (t: Tab) => t.kind === 'sftp'
/** a tab that runs sessions (not the file browser, not a blank new tab) */
export const isTerminalTab = (t: Tab) => t.kind !== 'sftp' && t.kind !== 'new'

/** A blank tab: search hosts and tabs, recent connections. It becomes a terminal when a host is picked. */
export function newBlankTab(title: string): Tab {
  return {...newTab('', title), kind: 'new'}
}

/** The blank tab turned into a connection to a host (the tab keeps its place and id). */
export function connectBlankTab(tab: Tab, hostId: string, title: string, choose: boolean): Tab {
  const t = newTab(hostId, title)
  return {...t, id: tab.id, choose}
}

export function leaves(n: Node): Leaf[] {
  return n.type === 'leaf' ? [n] : [...leaves(n.a), ...leaves(n.b)]
}

/** Split the pane `paneId` in direction `dir`; the new pane opens a session to the same host. */
export function splitPane(tab: Tab, paneId: string, dir: Dir): Tab {
  if (!isTerminalTab(tab)) return tab // a file browser or a blank tab cannot be split
  let created = ''
  const walk = (n: Node): Node => {
    if (n.type === 'leaf') {
      if (n.id !== paneId) return n
      const fresh: Leaf = {type: 'leaf', id: uid('pane'), hostId: n.hostId}
      created = fresh.id
      return {type: 'split', id: uid('split'), dir, a: n, b: fresh}
    }
    return {...n, a: walk(n.a), b: walk(n.b)}
  }
  const root = walk(tab.root)
  // a new pane is meant to be seen: leave the zoomed view
  return created ? {...tab, root, activePane: created, zoomPane: undefined} : tab
}

/** Remove a pane; its sibling takes the parent's place. Returns null when the last pane closes. */
export function closePane(tab: Tab, paneId: string): Tab | null {
  const walk = (n: Node): Node | null => {
    if (n.type === 'leaf') return n.id === paneId ? null : n
    const a = walk(n.a)
    const b = walk(n.b)
    if (!a) return b
    if (!b) return a
    return {...n, a, b}
  }
  const root = walk(tab.root)
  if (!root) return null
  const ids = leaves(root).map(l => l.id)
  return tidy({...tab, root, activePane: ids.includes(tab.activePane) ? tab.activePane : ids[0]})
}

/** Broadcast and zoom only mean something with two panes or more, and zoom needs its pane to exist. */
function tidy(tab: Tab): Tab {
  const ids = leaves(tab.root).map(l => l.id)
  const out = {...tab}
  if (ids.length < 2) { delete out.broadcast; delete out.zoomPane }
  else if (out.zoomPane && !ids.includes(out.zoomPane)) delete out.zoomPane
  return out
}

export function toggleBroadcast(tab: Tab): Tab {
  if (leaves(tab.root).length < 2) return tab
  return {...tab, broadcast: !tab.broadcast}
}

/** Show one pane alone, or bring the others back. */
export function toggleZoom(tab: Tab, paneId: string): Tab {
  if (leaves(tab.root).length < 2 || !hasPane(tab, paneId)) return tab
  return tab.zoomPane === paneId ? {...tab, zoomPane: undefined} : {...tab, zoomPane: paneId, activePane: paneId}
}

/** A new tab on the same host as the focused pane of a terminal tab. */
export function duplicateOf(tab: Tab, title: string): Tab | null {
  if (!isTerminalTab(tab)) return null
  const leaf = leaves(tab.root).find(x => x.id === tab.activePane) ?? leaves(tab.root)[0]
  return {...newTab(leaf.hostId, title)}
}

export function hasPane(tab: Tab, paneId: string): boolean {
  return leaves(tab.root).some(l => l.id === paneId)
}

/**
 * Drag a tab to a new place: `id` goes before (or after) `targetId`. The pinned tab (SFTP) stays first and
 * nothing goes before it; an unknown id changes nothing.
 */
export function moveTab(tabs: Tab[], id: string, targetId: string, after = false): Tab[] {
  const from = tabs.findIndex(t => t.id === id)
  const to = tabs.findIndex(t => t.id === targetId)
  if (from < 0 || to < 0 || from === to || tabs[from].pinned) return tabs
  const rest = tabs.filter(t => t.id !== id)
  let at = rest.findIndex(t => t.id === targetId) + (after ? 1 : 0)
  at = Math.max(at, rest.filter(t => t.pinned).length) // never before a pinned tab
  return [...rest.slice(0, at), tabs[from], ...rest.slice(at)]
}

export type DropSide = 'left' | 'right' | 'top' | 'bottom'

/**
 * A tab dropped on the side of a pane of another tab: its panes join that tab as a split next to the pane
 * (left / right: side by side; top / bottom: one above the other). They are the very same panes (same ids), so
 * their sessions go on without a reconnect. The focus goes to the first of them. Anything that is not two terminal tabs changes nothing.
 */
export function graftTab(target: Tab, paneId: string, source: Tab, side: DropSide): Tab {
  if (!isTerminalTab(target) || !isTerminalTab(source) || target.id === source.id || !hasPane(target, paneId)) return target
  const incoming = source.root
  const dir: Dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'top'
  const walk = (n: Node): Node => {
    if (n.type === 'leaf') return n.id === paneId ? {type: 'split', id: uid('split'), dir, a: before ? incoming : n, b: before ? n : incoming} : n
    return {...n, a: walk(n.a), b: walk(n.b)}
  }
  return {...target, root: walk(target.root), activePane: leaves(incoming).find(l => l.id === source.activePane)?.id ?? leaves(incoming)[0].id, zoomPane: undefined}
}

/** What a dragged tab carries, and which tab it is (a drag cannot be read before it is dropped). */
export const TAB_DRAG = 'application/x-vvterm-tab'
let dragging = ''
export const setDraggingTab = (id: string) => { dragging = id }
export const draggingTab = () => dragging

/** The side of a box a pointer is nearest to: where a dropped tab would split it. */
export function sideOf(x: number, y: number, w: number, h: number): DropSide {
  const d: [DropSide, number][] = [['left', x], ['right', w - x], ['top', y], ['bottom', h - y]]
  return d.reduce((a, b) => (b[1] < a[1] ? b : a))[0]
}

export interface Rect {x: number; y: number; w: number; h: number}
export interface Divider extends Rect {dir: Dir}

/**
 * Where each pane of a tab sits, as percentages of the area (every split halves its box), and the dividers
 * between them. The workspace draws the panes of all tabs side by side in one flat list placed with these boxes,
 * so a pane that moves to another place or another tab is the same element and its session never notices.
 */
export function paneRects(root: Node): {panes: Map<string, Rect>; dividers: Divider[]} {
  const panes = new Map<string, Rect>()
  const dividers: Divider[] = []
  const walk = (n: Node, r: Rect) => {
    if (n.type === 'leaf') { panes.set(n.id, r); return }
    if (n.dir === 'row') {
      const w = r.w / 2
      dividers.push({x: r.x + w, y: r.y, w: 0, h: r.h, dir: 'row'})
      walk(n.a, {...r, w})
      walk(n.b, {...r, x: r.x + w, w})
    } else {
      const h = r.h / 2
      dividers.push({x: r.x, y: r.y + h, w: r.w, h: 0, dir: 'col'})
      walk(n.a, {...r, h})
      walk(n.b, {...r, y: r.y + h, h})
    }
  }
  walk(root, {x: 0, y: 0, w: 100, h: 100})
  return {panes, dividers}
}

/** One pane taken out of a tab's split into a tab of its own; null when it is the tab's only pane. The pane keeps its id. */
export function popPane(tab: Tab, paneId: string, title: string): {rest: Tab; popped: Tab} | null {
  if (!isTerminalTab(tab) || leaves(tab.root).length < 2) return null
  const leaf = leaves(tab.root).find(l => l.id === paneId)
  const rest = leaf && closePane(tab, paneId)
  if (!leaf || !rest) return null
  return {rest, popped: {id: uid('tab'), title, root: leaf, activePane: leaf.id}}
}
