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
  if (document.getElementById(ROOT_ID)) return; // already mounted

  // document.currentScript is null in module contexts but fine here (IIFE).
  // Fall back to querying for the last loaded script with a data-api-key.
  const script = document.currentScript
    ?? document.querySelector('script[src*="/widget.js"][data-api-key]');
  const apiKey = script?.dataset?.apiKey;
  const apiUrl = script?.dataset?.apiUrl;

  if (!apiKey) {
    console.warn('[DevPanel widget] data-api-key missing on <script>, not mounting.');
    return;
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.appendChild(root);
  createRoot(root).render(<DevPanel apiKey={apiKey} apiUrl={apiUrl} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
