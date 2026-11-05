# Routines — Usine logicielle agentique

## Objectif

Faire progresser et surveiller le backlog **DEVPA-251** avec des résultats vérifiables à chaque exécution. Les routines de session ne remplacent pas Temporal : elles sont recréées périodiquement et ne constituent jamais l’autorité durable.

## Backlog suivi

- **DEVPA-252** — A · ExecutionAdapter CLI
- **DEVPA-253** — B · Temporal
- **DEVPA-254** — C · Runner hybride
- **DEVPA-255** — D · ExperienceWorkflow
- **DEVPA-256** — E · Delivery probant
- **DEVPA-257** — F · Estimation et vélocité
- **DEVPA-258** — R · Routines

## Déclencheurs

| Routine | Horaire local | Résultat attendu |
|---|---|---|
| Exécution du chantier courant | Toutes les heures à :17 | Un incrément testé et commité, puis un commentaire Plane avec preuves et prochaine action |
| Revue qualité et blocages | Toutes les 3 heures à :43 | PR, tests et dépendances revus ; petites corrections testées ; blocages documentés |
| Documentation et traçabilité | Toutes les 4 heures à :23 | Docs, diagrammes, contrats et DecisionRecords alignés avec le code réel |
| Digest quotidien | Tous les jours à 07:47 | Avancement, réel vs prévision, risques, chantier suivant et décision éventuelle |
| Vélocité et prévisions | Lundi à 08:16 | Throughput, cycle time, rework, coût, prévisions P50/P80/P95 et routage des drivers revus |

## Garde-fous

- Un seul chantier actif à la fois, dans l’ordre A → F, sauf dépendance explicitement résolue.
- Aucune PR, merge, deploy ou notification dupliquée ; toute reprise commence par réconciliation.
- Aucun appel direct aux API Anthropic ou Moonshot : Claude et Kimi restent des processus CLI.
- Aucun merge/deploy sans preuves complètes et rollback ; les actions R3 restent soumises à décision humaine.
- PC offline : attente durable, jamais d’échec artificiel ni de fallback implicite.
- Toute modification de contrat impose la revue du schéma, de l’exemple, du workflow et du driver concernés.
- Les crons natifs de session sont des déclencheurs locaux à recréer périodiquement. Ils ne remplacent ni Temporal Schedules ni les signaux durables.

## Références

- `docs/superpowers/specs/2026-11-02-agentic-dev-factory-architecture-design.md`
- `docs/architecture/README.md`
- `docs/architecture/migration/bullmq-to-temporal.md`
- `docs/architecture/security/autonomy-policy.md`
