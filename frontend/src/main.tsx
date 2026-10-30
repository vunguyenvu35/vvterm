import {lazy, Suspense} from 'react'
import {createRoot} from 'react-dom/client'
import SettingsApp from './lib/settings/SettingsApp'
import {BackendContext, bridgeBackend, inSettingsWindow, inTerminalWindow, installWindowBridge, wailsBackend, windowTarget} from './lib/backend'
import {ToastProvider} from './lib/ui/Toast'
import {ConfirmProvider} from './lib/ui/Confirm'
import {CapsLockWarning} from './lib/ui/CapsLockWarning'
import {installNoNativeMenu} from './lib/ui/noNativeMenu'
import {installSecureInputGuard} from './lib/ui/secureInput'
import './styles.css'

// the app (terminals, panels, xterm) is not loaded by the Settings window, which only needs its own page
const App = lazy(() => import('./App'))

installNoNativeMenu() // an app, not a web page: no Look Up / Translate / Inspect Element menu
installSecureInputGuard() // a password field must not leave macOS's secure input on (it stops input tools such as OpenKey in every app)

async function boot() {
  // The Settings window is a second process of the same binary; it is the only one that has the bridge bound.
  const settingsWindow = inSettingsWindow()
  // An app window (Duplicate in new window) is the whole app in another process: it asks for the host to open.
  const appWindow = inTerminalWindow()
  let initial: {host_id: string; title: string} | undefined
  if (appWindow) {
    installWindowBridge()
    initial = await windowTarget().catch(() => undefined)
  }
  // No StrictMode: it double-mounts effects in dev, which would open two SSH sessions per pane.
  createRoot(document.getElementById('root')!).render(
    <BackendContext.Provider value={settingsWindow ? bridgeBackend() : wailsBackend()}>
      <ToastProvider>
        <ConfirmProvider>
          {settingsWindow ? <SettingsApp /> : <Suspense fallback={<div className="gate" />}><App initial={initial} /></Suspense>}
          <CapsLockWarning />
        </ConfirmProvider>
      </ToastProvider>
    </BackendContext.Provider>,
  )
}

void boot()
