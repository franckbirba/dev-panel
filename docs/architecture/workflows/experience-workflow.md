# ExperienceWorkflow

[Diagramme interactif de l’ExperienceWorkflow](../diagrams/experience.html)

## Objet et contrats

`ExperienceWorkflow` transforme une spec UI/UX versionnée en `PrototypeRelease` immuable. Il choisit un exécutant par capacités vérifiées, produit une preview exécutable et exige des preuves visuelles avant de rendre le prototype disponible au build.

Références normatives : [ADR 0003](../adr/0003-cli-only-agent-execution.md), [ADR 0004](../adr/0004-hybrid-cloud-local-execution.md), [ADR 0005](../adr/0005-git-versioned-product-artifacts.md), [`RunSpec`](../contracts/execution-run-spec.schema.json), [`ExecutionEvent`](../contracts/execution-event.schema.json), [`PrototypeRelease`](../contracts/prototype-release.schema.json), [`DecisionRecord`](../contracts/decision-record.schema.json), [`ArtifactManifest`](../contracts/artifact-manifest.schema.json) et [`NodeRegistration`](../contracts/node-registration.schema.json).

## Entrée, état et sortie

L’entrée contient :

- `work_item_id`, `workflow_run_id`, le `DesignBrief` et l’URI/SHA-256 de la spec ;
- `prototype_id`, `prototype_version`, `design_system_sha`, les parcours, viewports et états attendus ;
- les capacités requises, dont `design`, et les contraintes de coût/qualité ;
- `worktree.placement`, `execution_policy.fallback_policy` et l’autorisation explicite `cloud_fallback` portée par le work item ;
- `revision`, héritée du `DeliveryWorkflow`.

Pour un driver CLI, l’activité reçoit un `RunSpec(stage = experience)` complet. `driver` reste l’une des valeurs du contrat `claude-code-cli`, `kimi-code-cli` ou `opencode-cli`. `KimiDesignBridge` suit le flux d’export natif et n’est pas présenté comme un driver de `RunSpec`.

L’état durable conserve l’état du graphe, le `node_id`/driver choisi et sa version, les `run_id`, les sessions natives, les références de sources, preview et preuves, ainsi que `revision`. La sortie de succès est une `PrototypeRelease` complète accompagnée des `ArtifactManifest` et `DecisionRecord` référencés. Aucune sortie partielle ne peut être consommée par `BuildWorkflow`.

## Graphe d’états

```text
design_brief_created
→ driver_selected
→ prototype_generated
→ preview_ready
→ visual_evidence_collected
→ quality_gate_passed
→ prototype_released

quality_rejected → prototype_generated, avec revision = revision + 1
capacité locale indisponible → attente durable → cloud_fallback autorisé ou escalate
question humaine → waiting_decision → état de reprise
```

## Transitions et artefacts

| État | Input | Activity/output | Success signal | Failure transition |
|---|---|---|---|---|
| `design_brief_created` | Spec à SHA fixe, parcours, tokens/composants, viewports et états | `create_design_brief` ; produit le brief et les critères du quality gate | Brief complet rattaché à `work_item_id` et à la spec | Entrée invalide : échec sans génération ; arbitrage produit : `waiting_decision` |
| `driver_selected` | Brief, capacités requises, `NodeRegistration`, coût et placement | `select_capable_driver` ; produit driver, version, task queue et politique de fallback | Une capacité vérifiée satisfait toutes les exigences | Aucun node : attente/fallback décrit ci-dessous ; aucune capacité compatible après fallback : `escalate` puis `waiting_decision` si nécessaire |
| `prototype_generated` | Brief, driver choisi, sources et design system à SHA fixes | `generate_prototype` ; produit les sources dans `prototypes/<PLANE-ID>/`, les exports et `DecisionRecord` | `source_location` et `source_sha` connus ; pour un CLI, `ExecutionEvent.completed` + artefacts requis | Erreur de contrat/artefact : étape incomplète ; `quality_rejected` : nouvelle révision ; indisponibilité : politique de fallback |
| `preview_ready` | Sources à `source_sha` | `deploy_prototype_preview` ; produit `preview_url` | La preview exécutable correspond exactement à `source_sha` | Déploiement transitoire : retry borné avec même clé ; résultat inconnu : réconcilier avant retry |
| `visual_evidence_collected` | Preview, parcours, viewports, états attendus | `collect_visual_evidence` ; produit screenshots, traces et `ArtifactManifest` | Screenshots desktop/mobile et preuves des parcours/états requis, SHA-256 vérifiés | Preuve absente ou empreinte invalide : retour à `prototype_generated` si le prototype est fautif, sinon nouvelle collecte technique bornée |
| `quality_gate_passed` | Sources, preview, preuves, critères UX/accessibilité/design system | `evaluate_experience_quality` ; produit le verdict et les décisions éventuelles | Tous les critères requis sont satisfaits | `quality_rejected → prototype_generated` et incrément de `revision`, ou escalade de driver autorisée |
| `prototype_released` | Release candidate et verdict | `publish_prototype_release` ; produit la `PrototypeRelease` immuable | Contrat complet validé et release publiée une seule fois | Validation refusée : rester dans l’état producteur fautif ; aucune publication partielle |

Le prototype utilise les vrais tokens et composants lorsqu’ils existent. `supported_states` contient au moins un état parmi `empty`, `loading`, `error`, `success`, et tous les états exigés par le brief sont effectivement vérifiés. Les screenshots respectent le contrat `artifact_ref`, `viewport`, `state`, `sha256`.

## Sélection par capacité et fallback local

`driver_selected` ne dépend jamais du seul nom d’un modèle. Le sélecteur :

1. filtre les `NodeRegistration.capabilities` sur les noms requis, la version testée, `worktree.placement` et l’état du node ;
2. rejette toute capacité non vérifiée ou dont la version ne correspond pas ;
3. vérifie les permissions, le budget et la politique d’autonomie ;
4. choisit selon qualité mesurée, coût et disponibilité, puis fige driver/version/node dans l’état du workflow.

Pour une activité locale, **`schedule_to_close = 24h`** couvre l’attente dans la task queue et l’exécution. Un PC éteint ne provoque pas d’échec immédiat : l’activité attend durablement. À l’échéance :

- si le work item autorise explicitement `cloud_fallback`, le workflow peut replanifier sur un node cloud offrant exactement les capacités requises et respectant coût, permissions et sensibilité des données ;
- sinon il applique **`escalate`**, sans transfert cloud implicite. L’escalade choisit une capacité supérieure autorisée ou entre en `waiting_decision` si aucune n’est disponible.

Aucun fallback ne change silencieusement de capacité, de version ou de classe de coût. Les credentials et sessions locales ne sont jamais copiés vers le cloud.

## Signaux

- `design_export_received` reprend un bridge natif après réception d’un export ; il porte `run_id`, `artifact_ref` et SHA-256. Pour Kimi Design, le chemin est `brief → app Kimi → export → ArtifactManifest → signal Temporal`, sans automatisation GUI dans le chemin critique.
- `preview_ready`, `visual_evidence_ready` et `quality_gate_resolved` ne sont acceptés que pour `prototype_id`, `prototype_version`, `source_sha` et `revision` courants.
- `quality_rejected` identifie les critères fautifs et les preuves ; il incrémente `revision` et produit une nouvelle version explicite au lieu de modifier une release existante.
- `decision_resolved` consomme une seule fois le `decision_id` d’un état `waiting_decision`.
- `cancel_requested` arrête les exécutions annulables et empêche toute publication ultérieure.

Les signaux dupliqués ou en retard ne déclenchent aucun nouvel effet. Les événements CLI utilisent les types `ExecutionEvent` existants, notamment `artifact_created`, `waiting_decision`, `resumed`, `completed` et `failed`.

## Retries, timeouts et reprises

- Les erreurs de contrat, permissions et artefacts non conformes ne sont pas corrigées par un retry technique.
- Les erreurs transitoires d’infrastructure suivent une Retry Policy bornée ; un refus du quality gate entraîne une révision, jamais un retry de la même sortie.
- Le délai local de 24 h est une limite `schedule_to_close`, pas une durée de sommeil d’un worker. Les runs CLI restent bornés par `execution_policy.max_duration_seconds` et utilisent les heartbeats requis par l’exécution hybride.
- Après un timeout ou une reprise avec résultat externe incertain, le workflow interroge la preview, le stockage ou l’export par clé avant de refaire l’effet.
- `waiting_decision` attend un signal/timer Temporal sans conserver de worker ou de processus CLI occupé.

## Idempotence

Les clés minimales sont :

- génération : `experience:<work_item_id>:<prototype_version>:<revision>:generate` ;
- preview : `experience:<prototype_id>:<source_sha>:preview` ;
- publication : `experience:<prototype_id>:<prototype_version>:release`.

Les artefacts sont dédupliqués par URI de contenu et SHA-256, les `ExecutionEvent` par `event_id`, et les exports natifs par `run_id` + `artifact_ref`. Une `PrototypeRelease` publiée est immuable : rejouer la publication retourne la release existante ; toute correction exige une nouvelle `prototype_version` et un nouveau `source_sha`.

**La transition vers `prototype_released` est refusée sans `source_sha`, `preview_url` et au moins un screenshot valide.** Les autres champs obligatoires du contrat, notamment `source_location`, `design_system_sha`, `user_flows`, `supported_states`, `decision_refs`, `native_session_ids`, `created_by` et `created_at`, sont également validés avant publication.

## Correspondance avec Plane

Le work item reste dans son état produit en cours pendant la conception. DevPanel peut lier la `PrototypeRelease`, les décisions et les preuves au `work_item_id`, mais ne crée pas de roadmap ni de statut technique concurrent dans Plane. `quality_rejected`, retries et `waiting_decision` restent des états Temporal. `prototype_released` alimente la Definition of Ready ; il ne marque jamais Plane `done`.
