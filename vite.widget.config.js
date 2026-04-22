// vite.widget.config.js
//
// Build target #2: a single-file IIFE bundle for the public /widget.js
// endpoint. Distinct from vite.config.js which builds the dashboard SPA.
// Run via `npm run build:widget`.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Rollup plugin: after build, read the emitted CSS asset (if any) and
// inline it into the JS chunk as a runtime style tag injection. Ensures
// consumer sites don't need a separate <link> tag.
function inlineCssPlugin() {
  return {
    name: 'inline-css-into-iife',
    generateBundle(_opts, bundle) {
      const cssFile = Object.keys(bundle).find(k => k.endsWith('.css'));
      const jsFile = Object.keys(bundle).find(k => k.endsWith('.js'));
      if (!cssFile || !jsFile) return;
      const css = bundle[cssFile].source ?? '';
      delete bundle[cssFile]; // drop the standalone .css output
      const prefix = `(function(){var s=document.createElement('style');s.setAttribute('data-devpanel-widget','');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})();`;
      bundle[jsFile].code = prefix + bundle[jsFile].code;
    }
  };
}

export default defineConfig({
  plugins: [react(), inlineCssPlugin()],
  // Widget imports html2canvas dynamically; we want it rolled into the
  // main chunk rather than a separate lazy-loaded JS file.
  build: {
    outDir: 'dist',
    emptyOutDir: false, // don't wipe dist/dashboard
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, 'src/react/widget-entry.jsx'),
      name: 'DevPanelWidget',
      formats: ['iife'],
      fileName: () => 'widget.js'
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
