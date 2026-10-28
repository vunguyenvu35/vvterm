import {createRoot} from 'react-dom/client'
import App from './App'
import SettingsApp from './lib/settings/SettingsApp'
import {BackendContext, bridgeBackend, inSettingsWindow, wailsBackend} from './lib/backend'
import {ToastProvider} from './lib/ui/Toast'
import {ConfirmProvider} from './lib/ui/Confirm'
import './styles.css'

// The Settings window is a second process of the same binary; it is the only one that has the bridge bound.
const settingsWindow = inSettingsWindow()

// No StrictMode: it double-mounts effects in dev, which would open two SSH sessions per pane.
createRoot(document.getElementById('root')!).render(
  <BackendContext.Provider value={settingsWindow ? bridgeBackend() : wailsBackend()}>
    <ToastProvider>
      <ConfirmProvider>
        {settingsWindow ? <SettingsApp /> : <App />}
      </ConfirmProvider>
    </ToastProvider>
  </BackendContext.Provider>,
)
