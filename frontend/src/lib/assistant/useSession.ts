import {useSyncExternalStore} from 'react'
import {sessionOfPane, watchPaneStatus} from '../terminal/panes'

/** The session id of a pane (empty until the terminal has opened its session). */
export function usePaneSession(paneId: string): string {
  return useSyncExternalStore(watchPaneStatus, () => sessionOfPane(paneId))
}
