# ADR 0005 — Artefacts produit versionnés dans Git

## Status: Accepted

## Context

Chaque livraison doit permettre de reconstituer pourquoi et à partir de quelles entrées elle a été produite. Une référence implicite à la « dernière version » d’un prototype ou une décision isolée du code empêche cette traçabilité.

## Decision

Les specs, prototypes sources HTML/React, ADR et `DecisionRecord` sont versionnés dans le repo Git du projet. La structure de référence est `docs/work-items/<PLANE-ID>/spec.md`, `docs/work-items/<PLANE-ID>/decisions/<DECISION-ID>.yaml` et `prototypes/<PLANE-ID>/`.

La chaîne obligatoire est : demande originale → work item Plane → spec versionnée → `PrototypeRelease` éventuelle → décision → PR/commits → release. Une `PrototypeRelease` est immuable et porte notamment `source_location`, `source_sha`, preview, screenshots et états couverts. Le Builder reçoit un `source_sha` précis, jamais une référence implicite à la dernière version.

MinIO/S3 contient les fichiers lourds : screenshots, traces, vidéos, exports de sessions et exports design. Les manifests rattachent ces objets aux runs et versions Git. Postgres DevPanel indexe les liens et métriques ; pgvector peut faciliter la recherche, mais ni l’un ni l’autre n’est une preuve ou une source de vérité.

## Consequences

- Les entrées d’un build sont reproductibles et auditables par SHA.
- Les décisions citent leur contexte, leurs options, leurs références et leur auteur, y compris le driver et la session native le cas échéant.
- Les objets volumineux restent hors Git tout en conservant des références immuables et vérifiables.
- Toute réponse sur l’historique doit citer les artefacts sources plutôt qu’un résumé non traçable.

## Alternatives rejected

- Faire d’AFFiNE le stockage autoritaire des specs et décisions.
- Stocker les sources et décisions uniquement dans MinIO, Postgres ou pgvector.
- Construire depuis la dernière version disponible d’un prototype sans SHA.
- Considérer un index de recherche comme une preuve.

## Migration notes

Rattacher les artefacts existants à leurs work items et conserver leurs références d’origine lors de leur indexation. Versionner les sources légères et décisions dans Git, déplacer uniquement les fichiers lourds vers MinIO et créer les manifests de liaison. Aucun artefact historique n’est réécrit silencieusement pour simuler une traçabilité absente.
