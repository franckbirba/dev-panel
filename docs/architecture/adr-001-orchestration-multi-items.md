# ADR-001 — Orchestration multi-items : vagues sur relations Plane, pas de DAG engine

**Statut : DRAFT — à valider.** Réfs : engine-contract §2, §9, §10 ; audit 2026-08-18 F5.

## Contexte

Le moteur séquence les steps DANS un work item (builder→reviewer→qa via YAML) mais ne connaît rien ENTRE les items : pas de dépendances, pas de batch, dispatch 1 item/appel, puller mono-projet. Or le travail réel arrive en cycles ordonnés — « Phase 1 — Zeno V2 générique » : 13 items où le kernel (ZENO-830) précède tout, puis resolver → NATS/Permify → pilotes → infra. Aujourd'hui ce séquencement vit dans la tête de Franck et se traduit en babysitting : dispatcher à la main, surveiller, dispatcher le suivant.

Les mémoires studio montrent aussi que **100 % des items vagues finissent `blocked`** (ZENO-230/231, crons sans payload…) — l'ordonnancement ne sert à rien si les items eux-mêmes ne sont pas dispatchables.

## Décision

### 1. Plane est la source de vérité des dépendances

On utilise les **relations natives Plane** (`blocked_by` / `blocks`) posées sur les work items. Pas de table de dépendances côté devpanl, pas de champ custom. Poser les relations = geste PM normal dans l'UI Plane (ou via MCP).

### 2. Garde au dispatch (unitaire)

`enqueueWorkflowStart` lit les relations de l'item : si un blocker n'est pas dans un état Done/Cancelled → **refus explicite** listant les blockers (même pattern que `project_not_linked`). Override `--force` possible (loggé en auto_decision).

### 3. `dispatch_wave` — le tool d'orchestration

Nouveau tool MCP `dispatch_wave({ cycle_id | work_item_ids[], max_parallel = 2 })` :
1. Résout les items + relations, construit le graphe, **détecte les cycles** (refus listant le cycle).
2. Topo-sort → vagues. Dispatch la vague 1 (borné par `max_parallel`).
3. S'enregistre dans une table `waves` (id, cycle_id, items + états, max_parallel, status, created_at).
4. **Re-tick événementiel** : quand un item atteint un état terminal (le webhook merge-coordinator et l'engine émettent déjà ces événements), la vague ré-évalue et dispatche les items débloqués. Pas de polling.
5. Échec d'un item → ses dépendants restent en attente avec raison visible, le reste de la vague continue. La vague se termine `partial` si des items sont bloqués par un échec — notification avec le sous-graphe restant.

### 4. Le contrat « agent-ready » (l'autre moitié du problème)

Un item est dispatchable si : description structurée (**Contexte / Travail à faire / Critères d'acceptation / Fichiers probables / Dépendances**), label `agent-ready`, priorité posée. `dispatch_wave` refuse les items non conformes (liste ce qui manque) ; le template devient un check du doctor (ADR-003) et la définition existe déjà dans la convention studio (≤400 LOC par item, posé par PM ou Franck).

### 5. Rollup

`cycle_overview` s'enrichit de l'état de vague : done / in-flight / en attente / **bloqué-par-quoi**. C'est la vue que Shelly donne en réponse à « ça donne quoi ? » pendant le refacto.

## Conséquences

- (+) Le séquencement sort de la tête de Franck ; une vague de 13 items se pilote par exceptions (notifications), pas par surveillance.
- (+) Zéro nouveau moteur : la garde au dispatch + un topo-sort + un listener d'événements existants.
- (−) La qualité de l'orchestration dépend de la qualité des relations posées dans Plane — geste PM à institutionnaliser (30 min pour poser les 13 relations Zeno V2).
- (−) `max_parallel` global à la vague, pas de pondération par coût — suffisant pour l'instant.

## Alternatives rejetées

- **DAG engine générique** (conditions, fan-in/out, artefacts inter-jobs) : YAGNI ; on a UN pattern réel (vagues merge-gated).
- **BullMQ FlowProducer** : modélise parent/enfant de *jobs* ; notre dépendance est « la PR du blocker est mergée », pas « le job est fini ». Mauvais niveau d'abstraction.
- **Séquencement manuel par Shelly** : c'est le statu quo — précisément le babysitting qu'on supprime.

## Arbitrages rendus (Franck, 2026-08-18)

1. ✅ **Armé dans une vague, refus sec hors vague.**
2. ✅ **Re-tick au merge de la PR** — c'est l'état du repo qui fait foi.
