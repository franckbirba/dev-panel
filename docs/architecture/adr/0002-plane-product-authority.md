# ADR 0002 — Autorité produit de Plane

## Status: Accepted

## Context

Les demandes arrivent par plusieurs canaux et doivent aboutir à un work item traçable. Plane est déjà utilisé et obligatoire dans les hooks de PR. Une roadmap ou un statut produit parallèle dans DevPanel créerait des vérités concurrentes.

## Decision

Plane est l’unique autorité pour le périmètre produit, la priorité, la roadmap, les cycles et le statut produit des work items. Toute livraison est rattachée à son identifiant Plane et à sa demande originale.

DevPanel ingère, synchronise et projette ces données sans recréer de roadmap concurrente. Temporal porte uniquement l’état technique des runs ; Git porte le code, les specs et les décisions ; Postgres DevPanel porte les read models et métriques. Un statut produit `done` exige les preuves de la Definition of Done, notamment la release déployée, les health checks et la demande originale mise à jour.

## Consequences

- Les interfaces DevPanel affichent des projections Plane, pas une vérité produit indépendante.
- Les états techniques détaillés ne sont pas imposés à Plane.
- Les PR et releases conservent un lien explicite avec le work item Plane.
- Un agent ne peut pas déclarer seul un work item terminé.

## Alternatives rejected

- Faire d’AFFiNE ou d’un document Git l’autorité de la roadmap.
- Faire de Postgres DevPanel ou de Temporal l’autorité du statut produit.
- Autoriser des work items locaux non réconciliés avec Plane.

## Migration notes

Conserver les identifiants Plane existants et leur obligation dans les hooks de PR. Rattacher les flux historiques à leurs work items sans créer de doublons. Les anciennes représentations restent des références ou projections jusqu’à leur retrait, jamais une seconde source de vérité.
