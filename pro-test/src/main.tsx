import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App, { renderTurnstileWidgets } from './App.tsx';
import { initI18n } from './i18n';
import './index.css';

initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Explicit Turnstile rendering after React mount.
  // Polls until the async Turnstile script is ready.
  const initWidgets = () => {
    if (window.turnstile) { renderTurnstileWidgets(); return; }
    setTimeout(initWidgets, 300);
  };
  setTimeout(initWidgets, 100);
});
