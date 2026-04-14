// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.{test,spec}.{js,mjs,ts}', 'src/**/*.{test,spec}.{js,mjs,ts}'],
    exclude: ['node_modules/**', 'dist/**', '.worktrees/**'],
    // vitest test pool: threads is the default. We pin it and mark isolate:true
    // so each .test.js file runs in its own module graph — important because
    // src/server/db.js and src/worker/automation.js hold module-global
    // singletons that tests swap out (initMasterDatabase, __setEnqueueForTests).
    pool: 'threads',
    isolate: true
  }
});
