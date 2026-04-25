// src/react/widget-entry.jsx
//
// IIFE entry for the standalone /widget.js bundle. This file exists only
// for the vite.widget.config.js build target — the React app (dashboard)
// and the npm `./react` export both use DevPanel.jsx directly.
//
// Bootstrap: read data-api-key / data-api-url from our own <script> tag,
// inject a root div, mount DevPanel once the DOM is ready. Idempotent.

import { createRoot } from 'react-dom/client';
import { DevPanel } from './DevPanel.jsx';

const ROOT_ID = 'devpanel-widget-root';

function mount() {
  const script = document.currentScript
    ?? document.querySelector('script[src*="/widget.js"][data-api-key]');

  if (document.getElementById(ROOT_ID)) {
    const existing = document.getElementById(ROOT_ID).dataset.apiKey;
    if (script?.dataset?.apiKey && existing && script.dataset.apiKey !== existing) {
      console.warn('[DevPanel widget] already mounted with a different apiKey; ignoring second <script>.');
    }
    return;
  }
  const apiKey      = script?.dataset?.apiKey;
  const apiUrl      = script?.dataset?.apiUrl;
  const environment = script?.dataset?.environment;

  let user = null;
  if (script?.dataset?.user) {
    try {
      const parsed = JSON.parse(script.dataset.user);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        user = parsed;
      } else {
        console.warn('[DevPanel widget] data-user must be a JSON object; ignoring.');
      }
    } catch (err) {
      console.warn('[DevPanel widget] data-user is not valid JSON; ignoring.', err.message);
    }
  }

  if (!apiKey) {
    console.warn('[DevPanel widget] data-api-key missing on <script>, not mounting.');
    return;
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.apiKey = apiKey;
  document.body.appendChild(root);
  createRoot(root).render(
    <DevPanel apiKey={apiKey} apiUrl={apiUrl} environment={environment} user={user} />
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
