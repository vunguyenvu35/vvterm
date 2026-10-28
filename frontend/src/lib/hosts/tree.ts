import type {Group, Host} from '../types'

export interface GroupNode {
  group: Group
  children: GroupNode[]
  hosts: Host[]
}

export interface Tree {
  roots: GroupNode[]
  ungrouped: Host[]
}

/** Arrange hosts under their groups (nested via parent_id). Hosts of unknown groups fall back to ungrouped. */
export function buildTree(groups: Group[], hosts: Host[]): Tree {
  const nodes = new Map<string, GroupNode>()
  for (const g of groups) nodes.set(g.id, {group: g, children: [], hosts: []})
  const roots: GroupNode[] = []
  for (const n of nodes.values()) {
    const parent = n.group.parent_id ? nodes.get(n.group.parent_id) : undefined
    if (parent) parent.children.push(n)
    else roots.push(n)
  }
  const ungrouped: Host[] = []
  for (const h of hosts) {
    const n = h.group_id ? nodes.get(h.group_id) : undefined
    if (n) n.hosts.push(h)
    else ungrouped.push(h)
  }
  return {roots, ungrouped}
}

export function countHosts(n: GroupNode): number {
  return n.hosts.length + n.children.reduce((s, c) => s + countHosts(c), 0)
}

const matches = (h: Host, q: string) => `${h.label} ${h.hostname} ${h.username} ${(h.tags ?? []).join(' ')}`.toLowerCase().includes(q)

/** Keep only the hosts matching `q`, and the groups that lead to one. A group whose own name matches keeps everything inside it. */
export function filterTree(tree: Tree, query: string): Tree {
  const q = query.trim().toLowerCase()
  if (!q) return tree
  const prune = (n: GroupNode): GroupNode | null => {
    if (n.group.name.toLowerCase().includes(q)) return n
    const children = n.children.map(prune).filter((c): c is GroupNode => !!c)
    const hosts = n.hosts.filter(h => matches(h, q))
    return children.length || hosts.length ? {group: n.group, children, hosts} : null
  }
  return {
    roots: tree.roots.map(prune).filter((n): n is GroupNode => !!n),
    ungrouped: tree.ungrouped.filter(h => matches(h, q)),
  }
}

/** How many of the group's hosts (all levels) have a session open, given the open host ids. */
export function countOpen(n: GroupNode, open: ReadonlyMap<string, unknown>): number {
  return n.hosts.filter(h => open.has(h.id)).length + n.children.reduce((s, c) => s + countOpen(c, open), 0)
}
