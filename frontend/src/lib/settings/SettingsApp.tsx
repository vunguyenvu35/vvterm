import {useCallback, useEffect, useState} from 'react'
import {useBackend} from '../backend'
import {DEFAULT_SETTINGS} from './defaults'
import {useAppearance} from './appearance'
import {SettingsWindow} from './SettingsWindow'
import type {Settings, VaultStatus} from '../types'

/**
 * Root of the Settings window process. It shows the same settings as the in-app window, but as the whole
 * content of its own native window. Data comes from the main window's process (see bridgeBackend), so the
 * values are re-read whenever this window is focused again.
 */
export default function SettingsApp() {
  const be = useBackend()
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const appearance = useAppearance(settings.theme)

  const refresh = useCallback(async () => {
    try {
      const [s, v] = await Promise.all([be.settings.get(), be.vault.status()])
      setSettings(s)
      setVault(v)
    } catch { /* the main window is gone: the process ends by itself */ }
  }, [be])

  useEffect(() => {
    void refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  useEffect(() => { document.documentElement.dataset.theme = appearance }, [appearance])
  useEffect(() => { document.documentElement.style.setProperty('zoom', String((settings.zoom || 100) / 100)) }, [settings.zoom])
  useEffect(() => { document.documentElement.dataset.motion = settings.reduce_motion ? 'reduced' : 'full' }, [settings.reduce_motion])
  useEffect(() => { document.title = 'Settings' }, [])

  if (!vault) return <div className="gate"><div className="muted">Loading…</div></div>
  return (
    <SettingsWindow native settings={settings} appearance={appearance} vault={vault} onSettings={setSettings}
      onVault={() => void refresh()} onChanged={() => void refresh()} onClose={() => {}} />
  )
}
