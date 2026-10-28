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

export type TabKind = 'terminal' | 'sftp'

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

export const isSftp = (t: Tab) => t.kind === 'sftp'

export function leaves(n: Node): Leaf[] {
  return n.type === 'leaf' ? [n] : [...leaves(n.a), ...leaves(n.b)]
}

/** Split the pane `paneId` in direction `dir`; the new pane opens a session to the same host. */
export function splitPane(tab: Tab, paneId: string, dir: Dir): Tab {
  if (tab.kind === 'sftp') return tab // a file browser cannot be split
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
  return created ? {...tab, root, activePane: created} : tab
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
  return {...tab, root, activePane: ids.includes(tab.activePane) ? tab.activePane : ids[0]}
}

export function hasPane(tab: Tab, paneId: string): boolean {
  return leaves(tab.root).some(l => l.id === paneId)
}
