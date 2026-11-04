# Architecture DevPanel

Ce répertoire est le point d’entrée de l’architecture cible. Les documents actifs décrivent les décisions et contrats à appliquer ; les documents historiques ne doivent pas servir à réinterpréter ces décisions.

Les [six diagrammes interactifs](diagrams/README.md) accompagnent la solution, les workflows, la traçabilité, l’autonomie et la migration.

## Lecture obligatoire et revue

L’ordre de lecture obligatoire est : **ADR → contrats → workflows → drivers → sécurité → migration**.

Toute modification d’un contrat impose une revue croisée du schéma, de son exemple, du workflow et du driver concernés.

## Active

- [Vision d’architecture de l’usine logicielle agentique](../superpowers/specs/2026-11-02-agentic-dev-factory-architecture-design.md)
- Décisions d’architecture :
  - [ADR 0001 — Orchestration durable par Temporal](adr/0001-temporal-durable-orchestration.md)
  - [ADR 0002 — Autorité produit de Plane](adr/0002-plane-product-authority.md)
  - [ADR 0003 — Exécution des agents par CLI uniquement](adr/0003-cli-only-agent-execution.md)
  - [ADR 0004 — Exécution hybride cloud et locale](adr/0004-hybrid-cloud-local-execution.md)
  - [ADR 0005 — Artefacts produit versionnés dans Git](adr/0005-git-versioned-product-artifacts.md)
  - [ADR 0006 — Retrait d’AFFiNE et du Storybook global du chemin critique](adr/0006-retire-affine-and-global-storybook.md)
- Domaines du socle d’architecture : [contrats](contracts/), [workflows](workflows/), [drivers](drivers/), [sécurité](security/) et [migration](migration/).

## Historical reference

- [Skills, Plugins & Jobs](../jobs.md) : architecture pré-Temporal conservée pour consultation historique.

## Operational runbooks

- [Déploiement](../DEPLOY.md)
- [Monitoring](../MONITORING.md)
