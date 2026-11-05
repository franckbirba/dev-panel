# ADR 0004 — Exécution hybride cloud et locale

## Status: Accepted

## Context

La coordination doit rester disponible 24/7, tandis que le PC local offre des capacités spécialisées et des sessions locales. Ce PC peut être éteint ou déconnecté : il ne doit devenir ni un point unique de défaillance ni une cause d’échec immédiat.

## Decision

Le cloud est l’autorité de coordination. Des task queues Temporal cloud et locales routent chaque activité selon ses capacités requises, son `placement`, sa deadline et sa politique de fallback. Les placements sont `local`, `cloud`, `preferred-local` et `any` ; les fallbacks sont `wait`, `cloud_fallback`, `escalate` et `deadline`.

L’absence du PC laisse une activité locale en attente durable, sans échec. À sa reconnexion, le runner consomme l’activité et le workflow reprend. Un fallback n’est permis que si les capacités et la politique du run l’autorisent. Toutes les exécutions utilisent heartbeats et clés d’idempotence.

Le runner local est un worker Temporal standard avec agent d’artefacts. Il ouvre uniquement des connexions sortantes sécurisées vers Temporal, DevPanel et MinIO, sans port entrant. Les credentials locaux ne sont pas transférés au cloud et chaque action locale est rattachée à un `run_id`.

## Consequences

- Le cloud continue à fonctionner sans le PC ; les travaux strictement locaux attendent ou suivent leur fallback explicite.
- Les capacités, heartbeats et runs courants des nodes sont observables.
- Les exécutions sensibles peuvent rester locales sans bloquer les autres activités.
- Une capacité indisponible ne justifie jamais un changement implicite de driver ou de placement.

## Alternatives rejected

- Faire du PC local le coordinateur ou une capacité obligatoire du cloud.
- Imposer une exécution exclusivement cloud ou exclusivement locale.
- Marquer en échec toute activité locale lorsque le PC est hors ligne.
- Router par nom de modèle sans vérifier les capacités du node.

## Migration notes

Enregistrer les nodes avec capacités et heartbeats, puis vérifier qu’une activité locale attend le PC hors ligne, reprend à sa reconnexion et téléverse ses artefacts sans resynchronisation manuelle. Vérifier également qu’un run cloud ne dépend d’aucune ressource du PC et qu’un fallback ne duplique aucun effet externe.
