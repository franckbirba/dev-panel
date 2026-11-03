# ADR 0003 — Exécution des agents par CLI uniquement

## Status: Accepted

## Context

Claude Code et Kimi Code fournissent les exécutants retenus, avec leurs sessions, permissions et capacités natives. DevPanel doit normaliser leur cycle de vie sans devenir un client des API de modèles ni supposer que tous les drivers ont les mêmes fonctions.

## Decision

Claude et Kimi sont lancés comme processus CLI non interactifs derrière un `ExecutionAdapter` commun : capacités, démarrage, streaming, reprise, annulation et export. DevPanel n’intègre aucun appel direct ni SDK d’exécution aux API Anthropic ou Moonshot.

Les événements et artefacts sont normalisés sans réduire les drivers à leur plus petit dénominateur commun. Les capacités telles que `resume`, `cron`, `goal`, `design`, `multimodal` et `permissions` sont vérifiées par version ; une capacité non vérifiée n’est pas supposée disponible. OpenCode est un driver optionnel, jamais une dépendance centrale ni une garantie d’équivalence avec Claude ou Kimi.

## Consequences

- Les credentials et sessions des CLI restent dans leur environnement d’exécution.
- Le routage dépend de capacités requises et mesurées, pas seulement du nom du modèle.
- Les fonctions natives restent accessibles sans devenir obligatoires pour les autres drivers.
- Les crons natifs ne remplacent jamais Temporal pour une action durable ou critique.

## Alternatives rejected

- Appeler directement les API Anthropic ou Moonshot depuis DevPanel.
- Rendre OpenCode obligatoire pour tous les runs.
- Automatiser une interface graphique comme chemin critique d’exécution.
- Présumer qu’une capacité existe sans test sur la version installée.

## Migration notes

Faire passer les drivers existants derrière le contrat `ExecutionAdapter` et tester le même `RunSpec` sur Claude et Kimi. Vérifier reprise, annulation, export, événements et artefacts, ainsi que l’absence d’appel direct aux API modèles. Conserver OpenCode facultatif et exclure les secrets des événements normalisés.
