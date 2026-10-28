import {useEffect, useMemo, useState} from 'react'
import {useBackend, windowTarget} from '../backend'
import {DEFAULT_SETTINGS} from '../settings/defaults'
import {useAppearance} from '../settings/appearance'
import {effective} from '../shortcuts/shortcuts'
import {newTab} from '../layout'
import {Workspace} from './Workspace'
import {errMsg} from '../util'
import type {Host, Settings} from '../types'

/**
 * Root of a terminal window process (Duplicate in new window): one terminal filling its own native window.
 * The session runs in the main window's process; this one only draws it and sends the keystrokes.
 * Closing the window ends the session.
 */
export default function TerminalWindowApp() {
  const be = useBackend()
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [hosts, setHosts] = useState<Host[]>([])
  const [target, setTarget] = useState<{host_id: string; title: string} | null>(null)
  const [error, setError] = useState('')
  const appearance = useAppearance(settings.theme)

  useEffect(() => {
    void windowTarget().then(setTarget).catch(e => setError(errMsg(e)))
    void be.settings.get().then(setSettings).catch(() => {})
    void be.hosts.listHosts({}).then(h => setHosts(h ?? [])).catch(() => {})
  }, [be])
  useEffect(() => { document.documentElement.dataset.theme = appearance }, [appearance])
  useEffect(() => { document.documentElement.style.setProperty('zoom', String((settings.zoom || 100) / 100)) }, [settings.zoom])
  useEffect(() => { if (target) document.title = target.title }, [target])

  const tab = useMemo(() => (target ? newTab(target.host_id, target.title) : null), [target])
  if (error) return <div className="gate"><div className="error" role="alert">{error}</div></div>
  if (!tab) return <div className="gate"><div className="muted">Loading…</div></div>
  return (
    <div className="app term-window">
      <div className="topbar window-bar" onDoubleClick={() => void be.system.toggleMaximise()}>
        <div className="traffic-space" />
        <span className="window-title">{tab.title}</span>
      </div>
      <div className="body">
        <Workspace tabs={[tab]} activeTab={tab.id} settings={settings} appearance={appearance} shortcuts={effective(settings.shortcuts)} hosts={hosts}
          onFocusPane={() => {}} onPaneExit={() => window.runtime?.Quit?.()} onClosePane={() => window.runtime?.Quit?.()} />
      </div>
    </div>
  )
}
