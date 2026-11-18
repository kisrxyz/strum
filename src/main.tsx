import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { loadRuntimeInfo } from './app/boot';
import { moveIdbToFiles } from './audio/userFiles';
import { bindLanguage } from './i18n/useLang';
import { loadSettingsFile } from './state/settingsFile';
import './styles/index.css';

// The song service serves the page in the installed app, so it answers at once; in the author's copy
// `npm run dev` opens the page a few seconds before the service is up: wait a little for it.
const WAIT_FOR_SERVICE_MS = 4000;

async function start(): Promise<void> {
  await Promise.all([loadSettingsFile(WAIT_FOR_SERVICE_MS), loadRuntimeInfo(WAIT_FOR_SERVICE_MS)]);
  void moveIdbToFiles();
  bindLanguage();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
