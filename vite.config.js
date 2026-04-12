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
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
  },
});
