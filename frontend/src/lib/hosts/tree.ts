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
