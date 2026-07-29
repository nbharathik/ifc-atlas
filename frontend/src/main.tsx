import React from 'react';
import ReactDOM from 'react-dom/client';
import { installThreeWarningFilter } from './services/viewer/threeWarningFilter';
// NOTE: the web-ifc single-thread patch (`./services/ifc/webIfcPatch`) is no
// longer imported here. Pulling it eagerly forced the web-ifc engine chunk
// into the entry before the shell painted (hurting LCP). The workers
// (metadata.worker.ts / ifc-convert.worker.ts) self-import it, and the only
// main-thread consumer - OBC.IfcLoader's live-parse fallback - now awaits the
// patch lazily right before IfcAPI.Init() (see ViewerPanel init()).
import { installBackendReadyListener } from './services/tauriBackendReady';
import { installApiAuthentication } from './lib/platform';
import { BackendGate } from './components/BackendGate';
import App from './App';
import './index.css';

installThreeWarningFilter();
installBackendReadyListener();
installApiAuthentication();

// BackendGate is a transparent pass-through on web; on the Tauri desktop build
// it holds a "Starting…" splash until the spawned backend sidecar answers.
const app = import.meta.env.DEV ? (
  <BackendGate>
    <App />
  </BackendGate>
) : (
  <React.StrictMode>
    <BackendGate>
      <App />
    </BackendGate>
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById('root')!).render(app);
