import {useSyncExternalStore} from 'react'
import {paneStatusVersion, summarizeStatus, watchPaneStatus} from '../terminal/panes'
import {leaves, type Tab} from '../layout'

/** A small mark in a tab: a spinner while its session connects, a red dot when it is closed. */
export function TabStatus({tab}: {tab: Tab}) {
  useSyncExternalStore(watchPaneStatus, paneStatusVersion)
  if (tab.kind === 'sftp' || tab.kind === 'new' || tab.choose) return null
  const s = summarizeStatus(leaves(tab.root).map(l => l.id))
  if (s === 'connecting') return <span className="tab-status connecting" role="img" aria-label="Connecting" title="Connecting…" />
  if (s === 'closed') return <span className="tab-status closed" role="img" aria-label="Closed" title="Closed" />
  return null
}
