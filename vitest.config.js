// vitest.config.js
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    root: '.',
    include: ['tests/**/*.{test,spec}.{js,jsx,mjs,ts,tsx}', 'src/**/*.{test,spec}.{js,jsx,mjs,ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', '.worktrees/**'],
    // vitest test pool: threads is the default. We pin it and mark isolate:true
    // so each .test.js file runs in its own module graph — important because
    // src/server/db.js and src/worker/automation.js hold module-global
    // singletons that tests swap out (initMasterDatabase, __setEnqueueForTests).
    pool: 'threads',
    isolate: true
  }
});
