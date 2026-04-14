// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.{test,spec}.{js,mjs,ts}', 'src/**/*.{test,spec}.{js,mjs,ts}'],
    exclude: ['node_modules/**', 'dist/**', '.worktrees/**']
  }
});
