// tests/_setup/env-isolation.js
//
// Les tests doivent partir d'un environnement neutre, pas de celui du shell
// qui les lance.
//
// Vécu le 2026-08-20 : `set -a; source .env.local` (la stack de dev locale,
// scripts/local-stack.sh) exporte `DEVPANEL_SSH_TOOLS=off` et
// `BACKLOG_PULL_*=0`. Ces réglages sont exactement ce qu'on veut en dev —
// et ils faisaient échouer 5 tests qui vérifient le comportement NON gaté
// (exec-ssh doit tenter le spawn pour prouver qu'il ne crashe pas). Cinq
// faux échecs, sur une suite par ailleurs verte : le pire signal possible,
// parce qu'il pousse à douter du code au lieu de l'environnement.
//
// On efface donc les variables qui pilotent le comportement du produit.
// Un test qui a besoin de l'une d'elles la pose lui-même — explicitement,
// dans son propre `beforeEach` — ce qui rend l'intention lisible.
const PRODUCT_BEHAVIOUR_ENV = [
  // Gating des tools SSH (ADR-003)
  'DEVPANEL_SSH_TOOLS',
  // Dispatch automatique (contrat §10)
  'BACKLOG_PULL_ENABLED',
  'BACKLOG_PULL_MAX_PER_TICK',
  // Routage des drivers (ADR-004)
  'DRIVER_DEFAULT',
  'FORCE_TIER',
  // Bornes du contrat §5/§6 — chaque test pose les siennes
  'STALL_TIMEOUT_MS',
  'FLEET_DAILY_SPEND_LIMIT',
];

for (const key of PRODUCT_BEHAVIOUR_ENV) {
  delete process.env[key];
}

// Les variantes par rôle (AGENT_TIMEOUT_BUILDER_MS, BUDGET_TOKENS_QA…) sont
// nombreuses et suivent un motif : on les efface par préfixe plutôt que de
// maintenir une liste qui divergerait.
for (const key of Object.keys(process.env)) {
  if (/^(AGENT_TIMEOUT_|BUDGET_TOKENS_|DRIVER_)/.test(key)) {
    delete process.env[key];
  }
}
