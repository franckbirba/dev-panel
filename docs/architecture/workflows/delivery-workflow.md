# DeliveryWorkflow

[Diagramme interactif du DeliveryWorkflow](../diagrams/delivery.html)

## Objet et autorités

`DeliveryWorkflow` orchestre un work item Plane de sa demande originale jusqu’à sa livraison observée. Temporal est l’autorité de `stage`, des attentes, de `revision` et des reprises ; Plane reste l’autorité du statut produit. Git contient les specs, prototypes sources et `DecisionRecord`, MinIO/S3 les preuves lourdes décrites par `ArtifactManifest`, et Postgres DevPanel leurs projections.

Références normatives : [ADR 0001](../adr/0001-temporal-durable-orchestration.md), [ADR 0002](../adr/0002-plane-product-authority.md), [ADR 0005](../adr/0005-git-versioned-product-artifacts.md), [`RunSpec`](../contracts/execution-run-spec.schema.json), [`ExecutionEvent`](../contracts/execution-event.schema.json), [`PrototypeRelease`](../contracts/prototype-release.schema.json), [`DecisionRecord`](../contracts/decision-record.schema.json) et [`ArtifactManifest`](../contracts/artifact-manifest.schema.json).

## Entrée, état et sortie

L’entrée du workflow contient :

- `work_item_id` au format UUID/ULID des contrats, l’URI de la demande originale et le dépôt cible ;
- `base_sha`, les dépendances, la classe de risque et `execution_policy` du futur `RunSpec` ;
- `experience_required`, vrai pour tout travail UI significatif ;
- les critères de vérification et la politique de release ;
- `revision = 0` au démarrage.

L’état durable minimal est `{workflow_run_id, work_item_id, stage, revision, active_child_workflow_id, artifact_refs, decision_id?}`. Les références d’artefacts sont immuables et ancrées sur un SHA ; aucune référence à « la dernière version » n’est acceptée.

La sortie de succès contient `work_item_id`, `stage = done`, `revision`, le SHA fusionné, l’identifiant de déploiement, les preuves de health check, les `ArtifactManifest`, la confirmation de mise à jour de la demande originale et celle de l’enregistrement des métriques réelles. Une sortie d’échec ou d’annulation conserve le dernier `stage`, la cause normalisée et les artefacts déjà produits ; elle ne met pas Plane `done`.

## Graphe d’états

```text
intake → discovery → specification → experience? → ready → build
       → verify → review → release → observe → done

experience? = experience si experience_required ou UI significatif, sinon ready

tout état actif → waiting_decision → état producteur ou état interrompu
quality_rejected(producteur) → producteur, avec revision = revision + 1
cancel_requested → cancelled
```

Un seul `DeliveryWorkflow` actif est autorisé par `work_item_id`, avec l’identifiant Temporal stable `delivery:<work_item_id>`. Les workflows enfants utilisent `experience:<work_item_id>:<revision>`, `build:<work_item_id>:<revision>` et `release:<work_item_id>:<revision>`. Une nouvelle révision ne réutilise donc jamais l’historique d’exécution d’une révision précédente.

## Étapes et preuves

| Étape | Input | Activity | Required artifacts | Success signal | Failure transition |
|---|---|---|---|---|---|
| `intake` | Demande originale, provenance, dépôt | `ingest_intake`, `create_or_get_plane_work_item` | Demande originale immuable, provenance et `work_item_id` Plane | Work item reconcilié sans doublon et demande rattachée | Erreur de contrat : échec sans transition ; indisponibilité transitoire : retry borné ; choix de périmètre : `waiting_decision` |
| `discovery` | Work item, demande, dépendances | `run_discovery` via `RunSpec(stage = discovery)` | Problème, utilisateurs, hors-périmètre, dépendances, classe de risque, estimation et hypothèses ; `DecisionRecord` des choix | `ExecutionEvent.completed` + artefacts requis validés | `quality_rejected → discovery` avec incrément de `revision` ; incertitude majeure : spike borné ou `waiting_decision` |
| `specification` | Résultats de discovery, décisions | `run_specification` via `RunSpec(stage = specification)` | `docs/work-items/<PLANE-ID>/spec.md`, critères testables, stratégie de vérification et SHA de spec | `ExecutionEvent.completed` + spec et critères validés | `quality_rejected → specification` ; artefact absent ou non conforme : étape incomplète, sans retry aveugle |
| `experience` | Spec à SHA fixe, design system, `execution_policy` | Enfant `ExperienceWorkflow` | `PrototypeRelease` immuable, screenshots, parcours, états et `DecisionRecord` associés | `prototype_released` avec `source_sha`, preview et screenshots | `quality_rejected → experience` ; décision de driver/coût : `waiting_decision` |
| `ready` | Spec, estimation, politique, éventuelle `PrototypeRelease` | `evaluate_definition_of_ready` | Checklist Definition of Ready complète et références immuables | Tous les critères sont présents ; tout `XL` est découpé | Élément manquant : retour à l’étape productrice ; arbitrage : `waiting_decision` |
| `build` | `ready`, `base_sha`, spec et prototype à SHA fixes | Enfant `BuildWorkflow` | Branche/worktree, commits, export de session, artefacts demandés par `output_contract` | `pr_ready` + artefacts collectés | Échec technique terminal : étape `build` en échec ; `quality_rejected → build` avec nouvelle `revision` |
| `verify` | PR/head SHA, critères de la spec | `run_verification` via le workflow enfant ou `RunSpec(stage = verify)` | `ArtifactManifest(kind = test-report)`, screenshots/traces/vidéos exigés par la stratégie | Vérifications requises vertes et preuves SHA-256 valides | Tests rouges ou preuves insuffisantes : `quality_rejected → build` ; panne d’outil : retry technique borné sans compter un rework |
| `review` | PR, résultats de vérification, décisions | `collect_review` | Revue approuvée et `DecisionRecord` des éventuels arbitrages | Signal de revue acceptée rattaché au head SHA | Refus : `quality_rejected` vers `specification`, `experience` ou `build` selon l’artefact fautif |
| `release` | PR approuvée et mergeable, preuves vertes, rollback | Enfant `ReleaseWorkflow` | Merge SHA, déploiement, health checks, preuves de release | `plane_done` retourné par l’enfant | `deploy_failed → rollback_required` dans l’enfant ; rollback/incident : `waiting_decision`, jamais `done` |
| `observe` | Release et preuves enregistrées | `observe_release`, `update_original_request`, `record_actual_metrics` | Confirmation de mise à jour de la demande originale, métriques réelles et références des preuves | Observation et réconciliation Plane réussies | Erreur transitoire : retry borné ; écart produit : `waiting_decision`, sans effacer la release |
| `done` | Sortie d’`observe` | Aucune activité de production supplémentaire | Definition of Done complète | Workflow clôturé | État terminal ; toute reprise exige un nouveau run explicite |

`ExecutionEvent.completed` ne suffit jamais seul : les artefacts exigés par `RunSpec.output_contract.required_artifacts` et les critères `acceptance_criteria` doivent être validés. Les manifests sont contrôlés par taille et SHA-256 avant transition.

## Signaux et attentes durables

- `quality_rejected` porte `{stage, failed_artifact_ref, reason, producer_stage, evidence_refs}`. Il est accepté uniquement pour le `stage` courant et le head SHA concerné. Le workflow fixe `stage = producer_stage`, incrémente `revision` exactement une fois et journalise le rework.
- `decision_resolved` porte le `decision_id` attendu, l’option et l’identité de l’approbateur. Un identifiant inconnu, expiré ou déjà consommé est ignoré sans nouvel effet.
- `review_completed`, `verification_completed` et `observation_completed` réconcilient les événements externes avec le SHA et le `workflow_run_id` courants.
- `cancel_requested` arrête les activités annulables et les enfants, conserve les preuves et termine en `cancelled` sans passer Plane `done`.

`waiting_decision` est un état durable Temporal libérant le worker : le workflow enregistre `decision_id`, la question, les options et `expires_at`, puis attend un signal ou un timer. Aucun processus CLI ni worker ne reste occupé pendant cette attente. L’expiration suit l’option prévue par la décision (`escalate`, annulation ou maintien de l’attente) ; elle ne vaut jamais approbation implicite. La reprise émet, pour un run CLI concerné, un `ExecutionEvent.resumed` corrélé au même `decision_id`.

## Reprises, retries et timeouts

- Une erreur de parsing ou de contrat, un artefact absent/non conforme et un refus de permission ne sont pas des erreurs transitoires : aucune transition de delivery et aucun retry aveugle.
- Les retries techniques sont bornés par la Retry Policy de l’activité et ne franchissent pas les quality gates. Les politiques spécifiques de `ExperienceWorkflow`, `BuildWorkflow` et `ReleaseWorkflow` prévalent.
- Un quality gate refusé produit `quality_rejected`, pas un retry Temporal de la même activité. L’incrément de `revision` distingue le rework d’une reprise technique.
- L’absence du PC local laisse l’activité en attente durable selon `placement` et `fallback_policy` ; ce n’est pas un échec.
- Les durées actives des runs CLI sont bornées par `RunSpec.execution_policy.max_duration_seconds`. Le fallback local d’expérience utilise `schedule_to_close = 24h` et `start_cli_run` du build utilise `start_to_close = 45 min` avec heartbeat toutes les 30 secondes.
- L’épuisement du budget ou une autorisation manquante passe en `waiting_decision`, sans retry.

Après redémarrage, Temporal rejoue l’historique. Une activité dont le résultat externe est incertain doit être réconciliée par sa clé d’idempotence avant toute nouvelle invocation.

## Idempotence

Les effets d’une étape utilisent la clé `delivery:<work_item_id>:<stage>:<revision>` ; ceux d’un enfant utilisent ses clés plus précises. La clé reste identique sur les retries et les signaux dupliqués, mais change sur une nouvelle révision. `event_id` déduplique l’ingestion des `ExecutionEvent`, `artifact_id` et SHA-256 dédupliquent les manifests, et les identifiants stables de workflow empêchent deux enfants autoritaires pour la même révision.

`DeliveryWorkflow.observe` est l’unique propriétaire de `update_original_request` et `record_actual_metrics`. Leurs effets utilisent respectivement les clés d’idempotence explicites `delivery:<work_item_id>:<deployment_id>:original-request` et `delivery:<work_item_id>:<deployment_id>:actual-metrics`, persistées avant l’appel externe et inchangées sur les retries. Aucune activité de `ReleaseWorkflow` ne revendique ces effets ni ces clés.

## Correspondance avec Plane

| État Temporal | Projection/action Plane |
|---|---|
| `intake` | Créer ou retrouver le work item sans doublon ; conserver le lien vers la demande originale |
| `discovery`, `specification`, `experience` | Conserver le statut produit du projet ; attacher les références utiles sans copier les états techniques |
| `ready` | Projeter l’état « prêt » seulement si le workflow Plane du projet le prévoit ; la checklist reste la preuve |
| `build`, `verify`, `review`, `release`, `observe` | Projeter l’état de travail en cours configuré par le projet ; lier PR et preuves |
| `waiting_decision`, `quality_rejected`, retry | Ne pas créer de statut produit parallèle ; conserver le work item actif et journaliser la cause dans DevPanel |
| `done` | Plane peut être `done` uniquement après le `plane_done` de `ReleaseWorkflow`, puis la mise à jour de la demande originale et l’enregistrement des mesures ; toute divergence est réconciliée depuis Plane |

Aucun agent, aucune projection Postgres et aucun événement `completed` isolé ne peut marquer le work item Plane `done`.
