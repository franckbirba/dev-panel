# Diagrammes d’architecture

Six vues interactives complètent le socle documentaire. Chaque HTML est autonome et propose zoom, recherche, focus, thèmes light/dark et export. Les fichiers JSON sont les sources éditables ; les reçus `*.visual-check.json` enregistrent les preuves de validation.

| Diagramme | HTML interactif | Source | Preuve navigateur |
|---|---|---|---|
| Architecture globale | [solution.html](solution.html) | [solution.architecture.json](solution.architecture.json) | [reçu](solution.visual-check.json) |
| DeliveryWorkflow | [delivery.html](delivery.html) | [delivery.workflow.json](delivery.workflow.json) | [reçu](delivery.visual-check.json) |
| ExperienceWorkflow | [experience.html](experience.html) | [experience.workflow.json](experience.workflow.json) | [reçu](experience.visual-check.json) |
| Traçabilité et décisions | [traceability.html](traceability.html) | [traceability.dataflow.json](traceability.dataflow.json) | [reçu](traceability.visual-check.json) |
| Autonomie R0–R3 | [autonomy.html](autonomy.html) | [autonomy.lifecycle.json](autonomy.lifecycle.json) | [reçu](autonomy.visual-check.json) |
| Migration BullMQ → Temporal | [migration.html](migration.html) | [migration.workflow.json](migration.workflow.json) | [reçu](migration.visual-check.json) |

## Validation

- Les six artefacts passent les **9 contrôles d’artefact** et la composition `showcase` avec **0 erreur et 0 avertissement**.
- Les vérifications navigateur passent à **1440×900, 1600×1000, 1920×1080 et 2048×1320**, sans débordement horizontal ou vertical, en light et dark.
- Les rendus 1440×900 ont également été relus visuellement. Les captures `*.visual-check.1440x900.light.png` conservent cette preuve.

Les contenus rédigés sont en français. L’interface fixe du viewer et l’attribut `<html lang>` restent en anglais, car Archify ne propose pas de localisation française de son chrome applicatif.
