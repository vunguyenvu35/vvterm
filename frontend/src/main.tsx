import {createRoot} from 'react-dom/client'
import App from './App'
import SettingsApp from './lib/settings/SettingsApp'
import TerminalWindowApp from './lib/terminal/TerminalWindowApp'
import {BackendContext, bridgeBackend, inSettingsWindow, inTerminalWindow, terminalWindowBackend, wailsBackend} from './lib/backend'
import {ToastProvider} from './lib/ui/Toast'
import {ConfirmProvider} from './lib/ui/Confirm'
import {CapsLockWarning} from './lib/ui/CapsLockWarning'
import './styles.css'

// The Settings window is a second process of the same binary; it is the only one that has the bridge bound.
const settingsWindow = inSettingsWindow()
const terminalWindow = inTerminalWindow() // Duplicate in new window

// No StrictMode: it double-mounts effects in dev, which would open two SSH sessions per pane.
createRoot(document.getElementById('root')!).render(
  <BackendContext.Provider value={settingsWindow ? bridgeBackend() : terminalWindow ? terminalWindowBackend() : wailsBackend()}>
    <ToastProvider>
      <ConfirmProvider>
        {settingsWindow ? <SettingsApp /> : terminalWindow ? <TerminalWindowApp /> : <App />}
        <CapsLockWarning />
      </ConfirmProvider>
    </ToastProvider>
  </BackendContext.Provider>,
)
