# ADR 0001 — Orchestration durable par Temporal

## Status: Accepted

## Context

DevPanel doit exécuter des processus 24/7 qui attendent des signaux, des décisions humaines, des PR ou des machines locales, puis reprennent après un incident. BullMQ orchestre les jobs historiques, mais ne doit plus définir de nouveaux workflows durables.

## Decision

Temporal auto-hébergé est l’unique autorité de l’état technique d’exécution : workflows, timers, schedules, signaux, attentes, reprises et retries. Une attente durable ne conserve pas un worker occupé.

BullMQ est strictement transitoire. Aucun nouveau workflow durable n’y est ajouté. Les crons natifs des CLI restent limités à des rappels locaux dans leurs sessions ; ils ne déclenchent jamais une action critique de production et ne doublent jamais une programmation Temporal. Plane conserve l’état produit et Postgres DevPanel les projections et analytics : aucun des deux ne remplace Temporal.

## Consequences

- Les reprises après redémarrage et les effets externes idempotents deviennent des exigences de conception.
- Chaque run possède une seule autorité d’orchestration à un instant donné.
- Les jobs courts et notifications migrent progressivement vers des activités Temporal courtes.
- La coexistence avec BullMQ est temporaire et ne doit jamais produire de double exécution externe.

## Alternatives rejected

- Conserver BullMQ comme orchestrateur durable cible.
- Construire un scheduler durable dans DevPanel ou Postgres.
- Utiliser les schedulers natifs de Claude ou Kimi pour le delivery ou la production.

## Migration notes

Migrer flux par flux, avec preuves de reprise, d’attente sans worker et d’idempotence. Les runs déjà autoritaires dans Temporal ne sont jamais rouverts dans BullMQ ; seuls les runs legacy non migrés peuvent continuer temporairement sur l’ancienne file. Pendant toute comparaison en shadow mode, une seule autorité exécute les effets externes.
