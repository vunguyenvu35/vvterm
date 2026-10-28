import {createRoot} from 'react-dom/client'
import App from './App'
import {BackendContext, wailsBackend} from './lib/backend'
import {ToastProvider} from './lib/ui/Toast'
import './styles.css'

// No StrictMode: it double-mounts effects in dev, which would open two SSH sessions per pane.
createRoot(document.getElementById('root')!).render(
  <BackendContext.Provider value={wailsBackend()}>
    <ToastProvider>
      <App />
    </ToastProvider>
  </BackendContext.Provider>,
)
