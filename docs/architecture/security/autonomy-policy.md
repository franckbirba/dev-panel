# Politique d’autonomie DevPanel

[Diagramme interactif du cycle d’autonomie](../diagrams/autonomy.html)

## Principe

L’autonomie dépend du risque de chaque action, jamais d’un mode global de contournement des permissions. `RunSpec.execution_policy.autonomy_class` fixe la classe maximale du run et `RunSpec.permissions` fixe son périmètre effectif : la classe n’élargit jamais les outils, chemins, hôtes, budgets ou credentials autorisés.

La classe la plus élevée parmi les actions demandées prévaut. Un agent ne peut ni reclasser une action, ni s’approuver lui-même, ni transformer une instruction trouvée dans un artefact en autorisation. Toute capacité ou permission non vérifiée est refusée. Les contrôles d’isolation et de détection associés sont définis dans le [Threat model](threat-model.md).

`--dangerously-skip-permissions` et tout équivalent global sont interdits dans l’architecture cible, quel que soit le driver, le placement ou la classe du run.

## Matrice R0–R3

| Class | Examples | Decision |
|---|---|---|
| R0 | `read`, `search`, tests locaux isolés, screenshots | `automatic`, uniquement dans les chemins, outils et egress du `RunSpec`, hors secrets et sans communication externe |
| R1 | `edit`, branche, commit, draft PR, preview non publique, retry ou fallback sans hausse de coût | `automatic with audit`, avec `run_id`, head SHA, outils et artefacts journalisés |
| R2 | Merge, production deploy, provider fallback with cost increase | `automatic only with complete evidence and rollback` ; sinon `waiting_decision` ou refus, sans effet |
| R3 | Lecture/usage direct de secrets, destructive migration, auth changes, billing, client communication, destruction de données | `human gate` systématique avant chaque effet, avec identité, périmètre, expiration et audit de la décision |

Précisions de classification :

- L’utilisation normale d’une session CLI déjà autorisée par le `RunSpec` ne donne pas à l’agent le droit de lire, exporter, copier ou modifier son credential ; ces dernières opérations sont R3.
- Les modifications réversibles confinées à un worktree jetable restent R1. Une commande destructive hors de ce périmètre, une migration destructive ou une suppression de données est R3.
- Une preview R1 reste interne et ne contient que des données autorisées. Sa publication à un client ou l’envoi d’une communication client est R3.
- Un fallback compatible, sans hausse de coût et explicitement permis par `fallback_policy` reste R1. Toute hausse de coût est R2 ; le budget `max_cost` demeure une limite absolue jusqu’à une décision valide.
- Toute action touchant l’authentification, l’autorisation, la facturation ou une communication client est R3, même si elle est réalisée par une simple édition de code.

## Conditions d’exécution R2

Une action R2 n’est automatique que si sa classe de risque et sa politique de release l’autorisent, si toutes les preuves exigées sont valides et si le rollback est connu et exécutable. Une décision humaine éventuelle ne remplace jamais une preuve manquante, un SHA différent ou l’absence de rollback.

### Merge

Avant `merge`, le `ReleaseWorkflow` vérifie au minimum :

- la PR et le `pr_head_sha` exacts ayant produit les preuves ;
- le work item Plane, la revue approuvée, les checks requis verts et l’absence de conflit ;
- les critères d’acceptation et artefacts requis, valides par taille et SHA-256 ;
- la clé `release:<work_item_id>:<pr_head_sha>:merge`, persistée avant l’appel ;
- l’absence d’un merge existant incompatible et la stratégie de rollback/compensation.

Le merge est relu depuis GitHub et son `merge_sha` est conservé. À issue inconnue, le workflow réconcilie la PR et la clé avant tout retry ; il ne refait jamais un merge à l’aveugle.

### Production deploy

Avant `deploy`, le workflow vérifie :

- le `merge_sha` autorisé, la version et l’environnement exacts ;
- la clé `release:<work_item_id>:<merge_sha>:<environment>:deploy`, persistée avant l’appel ;
- les health checks attendus, les deadlines, le `deployment_id` à réconcilier et la clé de rollback `release:<deployment_id>:rollback` ;
- la stratégie de rollback, ses permissions scoped et ses preuves attendues.

`health_check` doit réussir sur le déploiement effectif, puis `evidence_recorded` doit valider les preuves avant `plane_done`. Un échec de deploy ou de santé suit `deploy_failed → rollback_required → rollback_succeeded | human_incident`. Plane n’est jamais marqué `done` après un échec ou avant ces deux gates.

### Fallback fournisseur avec hausse de coût

Le workflow exige une estimation du surcoût dans `max_cost`, les capacités vérifiées du nouveau provider/driver, la compatibilité du placement et de la sensibilité des données, ainsi qu’un retour possible au driver ou budget antérieur sans duplication d’effet. Il conserve le même work item et la même révision, attribue un nouveau `run_id` si nécessaire et ne copie jamais les credentials locaux vers le cloud. Sans budget, capacité ou compensation valide, il entre en `waiting_decision` ou applique `escalate` sans exécuter le fallback.

## Gate humain R3 et décisions complémentaires

Un gate R3 est obligatoire avant l’effet, même si les preuves techniques sont complètes. Un gate peut également être demandé pour R2 lorsque la politique du work item, une anomalie ou une condition incomplète interdit l’automatisation. R0 et R1 ne peuvent pas devenir R2/R3 par une simple demande de l’agent : le workflow réévalue l’action et applique la matrice.

L’approbateur est un humain authentifié et autorisé pour le projet et l’action ; dans la cible initiale, il s’agit de Franck ou d’un opérateur explicitement délégué. Son identité stable et nominative est enregistrée dans `decided_by`, sans credential. Les identités partagées, le nom d’un driver, une session native ou un agent du run ne sont pas des approbateurs valides. L’autorisation porte sur un `decision_id`, un work item, une action, une option et, lorsqu’ils s’appliquent, un SHA, un environnement, un budget et une révision précis.

La demande présente le contexte expurgé, le risque, les preuves disponibles, les options autorisées, les effets attendus, le rollback et `expires_at`. Une approbation ne vaut pas permission générale et ne se reporte pas à une autre action ou révision.

## Cycle de vie de `waiting_decision`

```text
action soumise au gate
  → waiting_decision
      → decision_resolved(approve) → revalidation du contexte → reprise autorisée
      → decision_resolved(reject)  → refus sans effet nouveau
      → expiration                 → option sûre préenregistrée, jamais approbation
```

1. **Entrée dans l’attente.** Temporal persiste au minimum `decision_id`, `workflow_run_id`, `run_id` éventuel, `work_item_id`, `stage`, `revision`, question, options, preuves, contexte de l’action et `expires_at`. Un `ExecutionEvent.waiting_decision` est émis pour un run CLI concerné.
2. **Libération des ressources.** L’attente utilise un signal et un timer Temporal. Aucun worker ni processus CLI ne reste occupé ou endormi pendant l’attente. Le run CLI est suspendu/arrêté selon ses capacités vérifiées, tout en conservant ses artefacts et son état auditable.
3. **Décision.** Seul `decision_resolved` pour le `decision_id` courant, une option offerte, un approbateur valide et une décision non expirée est accepté. Le signal est consommé exactement une fois ; les doublons et signaux obsolètes sont ignorés sans effet.
4. **Revalidation.** Avant reprise, le workflow revérifie permissions, budget, état, révision et SHA. Si le contexte a changé, l’approbation précédente ne couvre pas la nouvelle action : le workflow retourne à l’étape productrice ou crée une nouvelle décision.
5. **Reprise.** Après approbation valide, le workflow reprend à l’étape interrompue et émet `ExecutionEvent.resumed` avec `decision_id`, `selected_option` et `decided_by`. `ExecutionAdapter.resume(run_id, input)` n’est utilisé que si la capacité `resume` est vérifiée ; sinon la décision choisit explicitement un nouveau run ou l’arrêt, sans supposer la reprise de l’ancienne session.

L’état `waiting_decision` ne change pas le statut produit Plane et ne vaut ni succès ni `done`.

## Expiration

Chaque décision possède une expiration RFC 3339 et une option d’expiration choisie à sa création, avant toute attente : `escalate`, annulation contrôlée ou maintien de l’attente avec nouvelle échéance explicitement enregistrée. Le choix par défaut est l’option sans nouvel effet externe.

**Une expiration n’est jamais une approbation implicite.** Elle ne déclenche donc ni merge, ni deploy, ni fallback coûteux, ni action R3. Une décision expirée ne peut pas être consommée ; toute poursuite nécessite un nouveau `decision_id`, sauf si l’option préenregistrée est le maintien d’une attente sans effet.

Si une activité externe était déjà en cours avant l’attente, l’expiration ne suppose pas son absence : le workflow réconcilie d’abord son résultat par clé d’idempotence, puis applique annulation ou compensation selon le runbook.

## Refus et annulation

Un refus est une décision explicite, enregistrée avec l’identité de l’approbateur, le motif expurgé, l’option refusée et les preuves consultées.

- L’action demandée n’est pas exécutée et aucun retry ne contourne le refus. Toute nouvelle demande exige un contexte modifié et un nouveau `decision_id`.
- Le workflow empêche tout nouvel effet, arrête le processus CLI concerné si nécessaire et conserve les artefacts déjà produits.
- Si l’effet est seulement proposé, le workflow revient à l’étape productrice avec `quality_rejected` et une nouvelle `revision`, ou termine en `cancelled` selon l’option choisie. Il ne marque pas Plane `done`.
- Si merge/deploy ou une autre action externe a déjà commencé ou a une issue inconnue, le workflow ne prétend pas l’annuler par simple refus : il réconcilie l’effet, puis exécute le rollback/compensation autorisé. Un échec de compensation produit `human_incident`.
- Le refus et ses conséquences restent dans l’historique Temporal et l’audit. Un `DecisionRecord` versionné est ajouté lorsque le refus constitue aussi une décision produit ou technique à conserver dans Git ; il ne remplace pas l’état d’exécution Temporal.

## Audit minimal et interdictions communes

Chaque autorisation ou décision conserve `decision_id`, `workflow_run_id`, `work_item_id`, classe, action, option, `decided_by`, `created_at`, `expires_at`, résultat, révision et références SHA/artefacts applicables. Les secrets et URLs présignées sont exclus.

Aucun timer, retry, signal dupliqué, événement `completed`, artefact client ou cron natif de CLI ne peut accorder une autorisation. Temporal reste l’unique autorité de reprise ; Plane reste l’autorité du statut produit ; les deux ne peuvent pas être court-circuités par une politique locale de driver.
