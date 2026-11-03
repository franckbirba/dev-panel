# ReleaseWorkflow

## Objet et autorité

`ReleaseWorkflow` fusionne une PR vérifiée, déploie, contrôle la santé, enregistre les preuves de release puis seulement marque Plane `done`. Temporal orchestre les effets et compensations ; GitHub conserve PR/commits, MinIO/S3 les preuves lourdes et Plane le statut produit. La mise à jour de la demande originale et l’enregistrement des métriques réelles appartiennent exclusivement à `DeliveryWorkflow.observe`, jamais à ce workflow.

Références normatives : [ADR 0001](../adr/0001-temporal-durable-orchestration.md), [ADR 0002](../adr/0002-plane-product-authority.md), [ADR 0005](../adr/0005-git-versioned-product-artifacts.md) et [`ArtifactManifest`](../contracts/artifact-manifest.schema.json).

## Entrée, état et sortie

L’entrée contient :

- `work_item_id`, `workflow_run_id`, dépôt, PR, head SHA et checks/revue requis ;
- environnement et politique de déploiement, version de release et références des vérifications ;
- stratégie de rollback et health checks attendus ;
- classe d’autonomie et preuves exigées pour autoriser merge/deploy ;
- deadlines des opérations externes et liste des preuves de release requises.

L’état durable conserve le `stage`, les SHA PR/merge, les identifiants de déploiement et de rollback, les clés d’idempotence, les références de health checks/preuves et tout `incident_id`. La sortie de succès contient `merge_sha`, `deployment_id`, les `ArtifactManifest` de release et la confirmation `plane_done`. `rollback_succeeded`, `human_incident`, `failed` et `cancelled` sont des sorties non réussies qui ne marquent pas Plane `done`.

## Graphe d’états

```text
pr_mergeable → merge → deploy → health_check → evidence_recorded → plane_done

deploy ou health_check en échec
  → deploy_failed
  → rollback_required
  → rollback_succeeded | human_incident

autorisation ou incident → waiting_decision → reprise autorisée ou human_incident
```

`merge` et `deploy` sont des actions R2 : elles ne sont automatiques que si les preuves sont complètes et le rollback connu. Une action relevant de R3 attend une décision humaine. Aucun timer d’expiration ne vaut approbation.

## Transitions, artefacts et échecs

| État | Input | Activity/output | Success signal | Failure transition |
|---|---|---|---|---|
| `pr_mergeable` | PR/head SHA, revue, checks, work item, classe de risque, rollback | `assert_mergeable` ; snapshot des préconditions | PR mergeable au head SHA vérifié, checks verts et preuves complètes | Head changé/checks rouges : retour `quality_rejected` au parent ; autorisation manquante : `waiting_decision` |
| `merge` | Snapshot mergeable et clé de merge | `merge_pr` ; `merge_sha` | Le merge lu depuis GitHub correspond à la PR et au head SHA autorisé | Conflit/refus : échec sans retry ; issue inconnue : réconciliation par clé/PR avant tout retry |
| `deploy` | `merge_sha`, environnement, version, rollback | `deploy_release` ; `deployment_id` et références de version | Le déploiement déclaré correspond exactement au `merge_sha` | `deploy_failed → rollback_required` ; issue inconnue : réconcilier avant retry |
| `health_check` | `deployment_id`, checks attendus | `run_release_health_checks` ; résultats et preuves de santé | Tous les health checks requis sont verts sur le bon déploiement | Échec : `deploy_failed → rollback_required` ; sonde indisponible : retry technique borné sans confondre avec un check vert |
| `evidence_recorded` | Merge, déploiement, santé et preuves de release requises | `record_release_evidence` ; `ArtifactManifest` requis | Preuves de release vérifiées par taille/SHA-256 et rattachées au `work_item_id` | Artefact absent/contrat invalide : rester avant `plane_done` ; panne transitoire : retry idempotent borné |
| `plane_done` | Confirmation complète d’`evidence_recorded` | `mark_plane_done` ; statut produit réconcilié | Plane relu `done` pour le bon `work_item_id` | Échec : release déployée mais workflow non terminé ; retry/réconciliation sans nouveau deploy |
| `rollback_required` | `deployment_id`, cause, stratégie de rollback | `rollback_release` ; `rollback_id` et résultat | Compensations terminées et santé du rollback vérifiée | Réussite : `rollback_succeeded` ; échec/indétermination : `human_incident` |
| `rollback_succeeded` | Résultat du rollback | `record_rollback_evidence` ; preuves et incident éventuel | Preuves enregistrées, sortie non réussie retournée au parent | Plane reste non `done` ; reprise ultérieure par nouvelle révision/décision |
| `human_incident` | Incident, diagnostics, identité de l’opérateur | Attente durable et activités de notification idempotentes | Décision humaine explicite et runbook de reprise | Aucun passage automatique à `plane_done` |

**Plane n’est jamais marqué `done` avant la réussite de `health_check` puis d’`evidence_recorded`.** L’ordre est imposé par le graphe et revérifié dans `mark_plane_done` à partir de l’état durable, pas seulement par l’ordre d’appel des activités.

## Signaux et réconciliation

- `mergeability_changed` et `merge_observed` portent dépôt, PR et head/merge SHA ; un signal pour un SHA obsolète est ignoré.
- `deployment_observed` et `health_check_completed` portent `deployment_id`, version et résultat ; ils réconcilient une activité interrompue sans créer un nouveau déploiement.
- `deploy_failed` enregistre la cause normalisée et les preuves, puis impose `rollback_required`.
- `decision_resolved` consomme une seule fois le `decision_id` courant et conserve l’identité de l’approbateur.
- `cancel_requested` interdit tout nouvel effet. Si merge/deploy est déjà en cours ou son issue inconnue, le workflow réconcilie puis applique la compensation nécessaire au lieu de supposer qu’aucun effet n’a eu lieu.

Les attentes de webhooks et `waiting_decision` sont durables et libèrent le worker. Les notifications d’incident sont des activités courtes dédupliquées par `incident_id` + type de notification.

## Idempotence de merge et deploy

Les clés suivantes sont obligatoires, persistées avant l’appel externe et inchangées sur les retries/signaux dupliqués :

```text
merge  = release:<work_item_id>:<pr_head_sha>:merge
deploy = release:<work_item_id>:<merge_sha>:<environment>:deploy
```

`merge_pr` recherche d’abord un merge correspondant à la clé, à la PR et au head SHA. Si GitHub indique que la PR est déjà fusionnée au bon SHA, il retourne ce résultat sans nouvelle fusion. Un merge d’un SHA différent ne peut pas être réutilisé.

`deploy_release` recherche d’abord un déploiement portant la clé et le `merge_sha`. Il reprend/réconcilie ce déploiement au lieu d’en créer un second. Une nouvelle version ou un nouvel environnement produit une nouvelle clé ; un retry de la même version conserve la clé.

Les autres effets utilisent également des clés stables : rollback `release:<deployment_id>:rollback`, enregistrement des preuves de release `release:<deployment_id>:evidence` et clôture Plane `release:<work_item_id>:<deployment_id>:plane-done`. Les artefacts sont dédupliqués par URI et SHA-256.

## Retries, timeouts et compensation

- Les appels réseau/infrastructure transitoires suivent une Retry Policy bornée propre à chaque activité. Les refus de permission, contrats invalides, preuves absentes, conflits et health checks rouges ne sont pas retryés comme des pannes transitoires.
- Les deadlines de merge, deploy, health check et rollback sont obligatoires dans la politique de release d’entrée et configurées comme timeouts d’activité ; aucune opération externe ne reste sans borne. Les attentes humaines/webhooks utilisent des timers Temporal distincts et n’occupent pas de worker.
- Un timeout après envoi d’un effet externe a une issue inconnue : la prochaine étape est toujours la réconciliation par clé, jamais un nouveau merge/deploy aveugle.
- L’épuisement des retries de `deploy` et tout health check rouge produisent `deploy_failed`. Le workflow exécute ensuite `rollback_required` ; il ne marque pas la release réussie et ne passe pas à `evidence_recorded`.
- Un échec de rollback produit `human_incident`, conserve le contexte et exige une décision explicite. `rollback_succeeded` conserve Plane hors `done` et retourne l’échec de release au `DeliveryWorkflow`.
- Après redémarrage, Temporal rejoue l’état et les clés persistées ; les activités relues renvoient les effets déjà constatés au lieu de les dupliquer.

## Correspondance avec Plane

| État Temporal | Action produit Plane |
|---|---|
| `pr_mergeable` à `health_check` | Work item en cours ; lier release et preuves sans le clôturer |
| `deploy_failed`, `rollback_required`, `rollback_succeeded`, `human_incident` | Work item non `done` ; conserver les références d’incident/rollback dans DevPanel |
| `evidence_recorded` | Preuves de release enregistrées, mais statut encore non `done` jusqu’à l’activité suivante |
| `plane_done` | Marquer puis relire le work item `done`, uniquement avec health checks et preuves complets |

Plane reste autoritaire en cas de divergence de statut produit. Temporal peut réconcilier et rejouer `mark_plane_done` avec la même clé, mais ne crée aucun statut produit parallèle.
