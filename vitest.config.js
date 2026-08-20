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
    isolate: true,
    // Plusieurs suites démarrent un conteneur Postgres jetable dans un
    // beforeAll (tests/_helpers/pg.js). Le hookTimeout par défaut (10s) est
    // sous le temps de démarrage réel dès que la machine est chargée — d'où
    // des échecs "pg container did not become ready" qui ne sont PAS des
    // régressions (le fichier passe seul). Le helper attend jusqu'à 90s ;
    // le hook doit lui laisser cette marge, sinon c'est lui qui coupe.
    hookTimeout: 120000
  }
});
