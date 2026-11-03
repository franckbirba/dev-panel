# BuildWorkflow

## Objet et contrat d’entrée

`BuildWorkflow` exécute un agent uniquement comme processus CLI derrière `ExecutionAdapter`, collecte ses preuves, vérifie le résultat et crée ou met à jour une PR. Il ne considère jamais la déclaration d’un agent comme une preuve de réussite.

Références normatives : [ADR 0001](../adr/0001-temporal-durable-orchestration.md), [ADR 0003](../adr/0003-cli-only-agent-execution.md), [ADR 0004](../adr/0004-hybrid-cloud-local-execution.md), [`RunSpec`](../contracts/execution-run-spec.schema.json), [`ExecutionEvent`](../contracts/execution-event.schema.json) et [`ArtifactManifest`](../contracts/artifact-manifest.schema.json).

L’unique entrée d’exécution est un `RunSpec(stage = build)` complet et valide, accompagné de la stratégie de vérification et des informations nécessaires à la PR. Le run utilise exactement `repository`, `base_sha`, `branch`, `worktree`, `driver`, `required_capabilities`, `input_artifacts`, `permissions`, `execution_policy` et `output_contract`. Pour une UI, les entrées incluent la `PrototypeRelease` et son `source_sha` précis.

La sortie de succès contient `run_id`, `workflow_run_id`, `work_item_id`, branche et head SHA, URL/numéro de PR, résultat de vérification, résumé des `ExecutionEvent` et `ArtifactManifest` requis. Une sortie `quality_rejected` contient les critères et preuves fautifs ; une sortie `failed` ou `cancelled` ne produit pas de transition de delivery réussie.

## Graphe d’états et activités

```text
build_requested
→ prepare_worktree
→ start_cli_run
→ stream_events
→ collect_artifacts
→ run_verification
→ create_or_update_pr
→ pr_ready

verification quality_rejected → sortie quality_rejected vers DeliveryWorkflow
waiting_decision → attente durable → resumed ou cancelled
```

| Activity | Input | Output / required artifacts | Success signal | Failure transition |
|---|---|---|---|---|
| `prepare_worktree` | `repository`, `base_sha`, `branch`, `worktree`, permissions | Worktree isolé au `base_sha`, branche dédiée et chemins autorisés | Le SHA et la branche lus sur disque correspondent au `RunSpec` | `invalid_run_spec`/`permission_denied` : échec sans retry ; capacité locale absente : attente/fallback du `RunSpec` |
| `start_cli_run` | `RunSpec` validé, driver/version et capacités du node | `run_id`, processus CLI et `ExecutionEvent.started` | Processus non interactif démarré derrière le driver choisi | Trois retries uniquement pour les trois erreurs transitoires autorisées ; autres erreurs : échec ou `waiting_decision` |
| `stream_events` | `run_id` et handle du processus | Flux ordonné `ExecutionEvent`, heartbeats, logs expurgés et statut terminal | `completed`, `failed` ou `cancelled` reçu avec séquences valides | Rupture transitoire : reprise du stream sans rejouer le processus ; contrat/secret : échec de validation |
| `collect_artifacts` | `output_contract.required_artifacts`, événements `artifact_created` | Un `ArtifactManifest` par preuve externalisée, taille et SHA-256 vérifiés | Tous les artefacts requis sont présents et vérifiables | `artifact_missing` : échec sans retry ; upload/réseau transitoire : reprise idempotente bornée |
| `run_verification` | Head SHA, artefacts, `acceptance_criteria`, stratégie de test | `ArtifactManifest(kind = test-report)` et autres preuves exigées | Tous les critères et tests requis sont verts | Tests rouges/preuves insuffisantes : `quality_rejected` ; panne transitoire de l’outil : retry borné sans changer le verdict |
| `create_or_update_pr` | Branche/head SHA vérifié, `work_item_id`, preuves | PR contenant le lien Plane et les références de preuves | PR existante réconciliée ou créée pour le head SHA vérifié | Conflit ou refus de permission : échec sans retry ; réseau : réconciliation puis retry idempotent borné |

Le workflow conserve `head_sha` et ne vérifie/publie jamais un commit différent de celui ayant produit les preuves. Si le head change, la vérification et les artefacts précédents sont invalidés et une nouvelle révision est requise.

## `start_cli_run` : politique obligatoire

L’activité démarre Claude Code ou Kimi Code comme processus CLI non interactif ; OpenCode reste optionnel. Aucun appel direct aux API modèles n’est autorisé.

- **Heartbeat : toutes les 30 secondes.** Les heartbeats d’activité permettent à Temporal de détecter une reprise ; le flux normalisé peut contenir des `ExecutionEvent.heartbeat` avec `active_duration_seconds`.
- **`start_to_close = 45 min`.** Cette limite s’applique à chaque tentative de l’activité. `execution_policy.max_duration_seconds` borne également la durée active du processus et ne prolonge pas cette limite.
- **Trois retries maximum**, donc au plus quatre tentatives en comptant la tentative initiale. La Retry Policy correspondante utilise `maximumAttempts = 4` et conserve la même clé d’idempotence.
- Seuls `process_start_failed`, `network_unavailable` et `provider_rate_limited`, lorsqu’ils sont normalisés comme erreurs transitoires avec `ExecutionEvent.failed.payload.retryable = true`, sont retryables.
- `invalid_run_spec`, `permission_denied` et `artifact_missing` sont non retryables. Un code inconnu est non retryable par défaut.

| `error_code` | Classification | Reprise |
|---|---|---|
| `process_start_failed` | Transitoire | Jusqu’à trois retries, après vérification qu’aucun processus du même `run_id` ne vit déjà |
| `network_unavailable` | Transitoire | Jusqu’à trois retries avec backoff de la Retry Policy |
| `provider_rate_limited` | Transitoire | Jusqu’à trois retries en respectant l’échéance fournisseur expurgée ; aucun fallback implicite |
| `invalid_run_spec` | Permanent | Aucun retry ; échec avant effet |
| `permission_denied` | Permanent/autorisation | Aucun retry ; échec ou `waiting_decision` selon la politique |
| `artifact_missing` | Preuve absente | Aucun retry ; étape incomplète |
| Timeout, heartbeat perdu ou autre code | Non classé comme transitoire autorisé | Réconciliation du processus et échec contrôlé ; aucun retry automatique au titre des trois erreurs |

Après épuisement des retries, le workflow termine en échec avec le dernier `error_code` et les artefacts de diagnostic. Il ne change pas de driver sans décision de routage compatible avec les capacités et `fallback_policy`.

## Événements, attentes et annulation

`stream_events` impose `sequence >= 1`, strictement croissante par `run_id`, et ingère chaque `event_id` une seule fois. Les payloads sont validés selon `type` et expurgés de secrets. Les contenus volumineux sont remplacés par `artifact_ref`; un `stdout`/`stderr` tronqué sans référence est invalide.

Un `ExecutionEvent.waiting_decision` fait passer le workflow dans l’état durable `waiting_decision` et libère le worker. Le signal `decision_resolved` doit correspondre au `decision_id`, à une option autorisée et à une décision non expirée ; la reprise appelle `ExecutionAdapter.resume(run_id, input)` si la capacité `resume` est vérifiée, puis accepte `ExecutionEvent.resumed`. Sans capacité `resume`, aucune reprise de session n’est supposée : le workflow applique la décision explicite (nouveau run ou arrêt).

`cancel_requested` invoque `ExecutionAdapter.cancel(run_id)`, collecte les preuves déjà disponibles et attend `cancelled`. Une annulation ne déclenche pas de retry et ne marque pas Plane `done`.

## Timeouts et reprises techniques

- Le heartbeat de 30 s et le `start_to_close` de 45 min de `start_cli_run` sont fixes.
- Les autres activités ont des deadlines bornées par leur configuration d’activité et par la politique du run ; les attentes de décision, de capacité locale ou de webhook sont des attentes Temporal, pas des activités endormies.
- L’absence du PC n’est pas un échec : le routage respecte `worktree.placement` et `execution_policy.fallback_policy` (`wait`, `cloud_fallback`, `escalate`, `deadline`).
- Après redémarrage du worker, Temporal reprend depuis son historique. Le stream reprend au dernier `event_id`/numéro de `sequence` persisté ; il ne relance pas le CLI pour une simple perte de connexion.
- Si l’issue d’un effet externe est inconnue, le workflow réconcilie d’abord le processus, l’artefact ou la PR par sa clé. Il ne refait jamais un effet à l’aveugle.

## Idempotence

| Effet | Clé stable sur les retries |
|---|---|
| Préparation du worktree | `build:<run_id>:prepare-worktree` |
| Démarrage du run | `build:<run_id>:start-cli` ; un seul processus autoritaire par `run_id` |
| Ingestion d’événement | `event_id` ; ordre contrôlé par `run_id` + `sequence` |
| Upload/collecte | `run_id` + URI + SHA-256, avec `artifact_id` stable |
| Vérification | `build:<run_id>:<head_sha>:verify` |
| Création/mise à jour de PR | `build:<work_item_id>:<branch>:pr` |

Les retries partagent ces clés. Une nouvelle révision reçoit un nouveau `run_id`, mais la clé de PR permet de retrouver et mettre à jour la PR de la branche au lieu d’en créer une seconde.

## Correspondance avec Plane

Le build et la vérification restent des états techniques Temporal projetés sur l’état de travail en cours configuré dans Plane. La PR contient obligatoirement le `work_item_id` Plane et les preuves lui sont rattachées. `quality_rejected`, retries, `waiting_decision` et échecs techniques ne changent pas le statut produit en `done`. `pr_ready` permet à `DeliveryWorkflow` d’entrer en revue, mais ne clôt jamais le work item.
