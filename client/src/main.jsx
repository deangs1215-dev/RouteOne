import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import App from './App';
import ConnectionBanner from './components/ConnectionBanner';
import { initOffline } from './offline';
import './index.css';

// The shell-caching service worker only makes sense for the built app; in dev
// it would serve stale Vite modules. The offline snapshot/outbox (offline.js)
// works in both modes.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  } else {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
}
initOffline();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ConnectionBanner />
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
