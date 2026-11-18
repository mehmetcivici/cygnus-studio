import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme';
import { currentLang, t } from './i18n';
import { toast } from './ui';
import { initNavSync } from './app/nav';
import { installEstopShortcut, onEstop } from './app/estop';
import { App } from './App';

document.documentElement.lang = currentLang();
initNavSync();
installEstopShortcut();
// User feedback for every E-STOP; the bus service registers the handler that actually stops hardware.
onEstop(() => toast.error(t('app.estopSent'), { id: 'estop', duration: 3000 }));

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
