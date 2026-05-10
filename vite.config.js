import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  root: 'src/dashboard',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/dashboard'),
    },
  },
  base: '/dashboard/',
  server: {
    proxy: {
      '/api': 'http://localhost:3030',
    },
  },
  build: {
    // The legacy Vite SPA now ships at /dashboard?legacy=1.
    // The new chat-first surface (apps/chat) owns dist/dashboard/.
    outDir: '../../dist/dashboard-legacy',
    emptyOutDir: true,
  },
});
