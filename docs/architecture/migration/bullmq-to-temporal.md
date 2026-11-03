# Migration de BullMQ vers Temporal

[Diagramme interactif de la migration](../diagrams/migration.html)

## Objet et invariants

Cette migration remplace progressivement l’orchestration BullMQ par Temporal, sans big bang et sans transférer les responsabilités de Plane, Git ou Postgres. Elle applique [ADR 0001](../adr/0001-temporal-durable-orchestration.md), [ADR 0002](../adr/0002-plane-product-authority.md), [ADR 0003](../adr/0003-cli-only-agent-execution.md) et les contrats des workflows [Delivery](../workflows/delivery-workflow.md), [Build](../workflows/build-workflow.md) et [Release](../workflows/release-workflow.md).

Les invariants sont obligatoires pendant toutes les étapes A–F de la spec d’architecture :

- un run possède exactement une autorité d’orchestration et un seul propriétaire d’effets externes à un instant donné ;
- le shadow et le dual-read ne créent ni PR, merge, déploiement, notification, mise à jour Plane ni appel client supplémentaire ;
- un run devenu autoritaire dans Temporal n’est jamais rouvert dans BullMQ, y compris pendant un rollback ;
- les runs BullMQ non migrés peuvent terminer sur leur file d’origine sans être copiés au milieu de leur exécution ;
- aucune purge de jobs, files, événements, artefacts ou données historiques n’est réalisée pendant les étapes A–F ;
- aucun cron natif Claude/Kimi ne déclenche une action déjà programmée dans Temporal ou BullMQ.

## Autorités et registre de migration

| Domaine | Autorité | Ce que les autres systèmes peuvent faire |
|---|---|---|
| État technique, timers, signaux, retries et reprises d’un run migré | Temporal | Postgres projette l’état ; BullMQ conserve seulement l’historique legacy |
| État technique d’un run legacy non migré | BullMQ, pendant la coexistence | Temporal peut calculer un shadow sans exécuter ses effets |
| Périmètre, priorité, cycle et statut produit | Plane | Temporal réalise les transitions techniques ; DevPanel projette sans créer de roadmap concurrente |
| Code, PR, specs, prototypes sources et décisions | Git/GitHub | Temporal appelle des activités idempotentes ; Postgres indexe les références |
| Read models, événements normalisés, métriques et comparaisons | Postgres DevPanel | Aucune projection ne décide seule d’une reprise ou d’un effet externe |
| Fichiers lourds et preuves | MinIO/S3, décrits par `ArtifactManifest` | Postgres et les workflows conservent URI et SHA-256 |

Le registre de migration DevPanel associe au minimum `{flow, run_id, work_item_id?, authority, external_effect_owner, generation, legacy_job_id?, temporal_workflow_id?, migrated_at?}`. `authority` et `external_effect_owner` désignent le même système. Toute bascule incrémente `generation` dans une transaction avant tout nouveau dispatch.

Les workers BullMQ et les activités Temporal vérifient cette génération avant chaque effet. Une génération obsolète est refusée (« fenced »), pas mise en attente puis rejouée aveuglément. Les clés d’idempotence des workflows et le journal des effets permettent de réconcilier une activité dont l’issue est incertaine. Le registre ne remplace pas Temporal comme historique d’exécution : il empêche seulement deux autorités d’agir sur le même run.

## Inventaire des flux et correspondances

La migration est approuvée séparément pour chaque ligne. « Rollback » ne signifie jamais reprendre dans BullMQ un run déjà migré.

| Flux | current entry point | current state | Temporal replacement | data owner | migration test | rollback |
|---|---|---|---|---|---|---|
| `backlog-puller` | `startBacklogPuller`, intervalle de polling et work items Plane `Todo` | Timer legacy et dispatch BullMQ ; Plane porte les états produit | Temporal Schedule + activité de dispatch, avec workflow stable `delivery:<work_item_id>` | Plane pour `Todo` ; Temporal pour le schedule et le dispatch ; Postgres pour la projection | Deux ticks et une reprise après arrêt ne créent aucun doublon pour le même work item ; un item déjà actif est ignoré | Désactiver le Schedule pour les nouveaux dispatches ; reprendre le polling legacy uniquement pour les work items non migrés, avec génération fence |
| `work-item` | YAML builder → reviewer → QA | Chaîne de jobs et état intermédiaire BullMQ | `DeliveryWorkflow` parent et `BuildWorkflow` enfant | Temporal pour stage/reprise ; Plane pour le produit ; Git pour code/specs ; MinIO pour les preuves | Tuer puis redémarrer le worker pendant build et vérification : reprise au dernier événement, sans relancer le CLI ni dupliquer la PR | Les runs legacy non migrés finissent sur BullMQ ; arrêter les nouveaux starts Temporal ; continuer/réconcilier dans Temporal les runs déjà migrés |
| `replan` | Workflow enfant PM et révision du parent | Replanification et compteur de révision portés par la chaîne legacy | Child workflow et signal de reprise du parent | Temporal pour `revision` et le signal ; Plane conserve le statut produit | Signaux dupliqués, refus QA et reprise après redémarrage : une seule incrémentation par refus et jamais au-delà de `max_revisions` | Ne pas rejouer le signal dans BullMQ pour un run migré ; seuls les replans legacy non migrés restent sur l’ancien chemin |
| `merge-coordinator` | Activité unique de merge d’une PR d’agent | Coordination BullMQ et appel GitHub | `ReleaseWorkflow`, avec clés de merge/deploy et réconciliation GitHub | GitHub pour PR/merge ; Temporal pour l’exécution ; Plane pour le statut produit | Deux livraisons du même signal et un crash après appel produisent une seule fusion ; le merge relu correspond au head SHA autorisé | Geler les nouveaux merges concernés ; réconcilier par clé ; ne jamais renvoyer le merge à BullMQ pour un run Temporal |
| `cycle-audit` | Audit QA de cycle | Job d’audit legacy, potentiellement relancé avec le polling | Temporal Schedule + workflow d’audit, identifiant `audit:<cycle_id>` | Plane pour le cycle ; Temporal pour l’audit ; Postgres/MinIO pour le rapport et ses preuves | Deux ticks, un retry et une coalescence ne laissent aucun audit concurrent pour un même cycle ; un second déclenchement retrouve l’audit existant | Désactiver le Schedule migré ; les audits non commencés et non migrés peuvent rester legacy ; ne pas dupliquer un audit Temporal actif |
| `crons` | Enregistrement des routines existantes | Routines BullMQ/répétables et éventuels rappels natifs | Temporal Schedules, une routine critique n’ayant qu’un seul schedule autoritaire | Temporal pour la planification ; le domaine cible reste propriétaire de ses données | Simuler plusieurs intervalles manqués puis la coalescence : exactement un déclenchement rattrapé, aucun déclenchement CLI parallèle | Désactiver le nouveau Schedule ; réactiver seulement les routines non migrées après vérification qu’aucun Schedule Temporal équivalent ne reste actif |
| `notifications` | Alertes et callbacks de fin de job | Job court et appels externes depuis BullMQ | Activités Temporal courtes, dédupliquées par `event_id` et clé de notification | Temporal pour la livraison technique ; Postgres pour le journal/outbox ; le destinataire externe pour la réception constatée | Callback dupliqué et crash après envoi/avant acquittement : au plus une notification effective, réconciliation avant tout retry | Les callbacks de runs legacy restent legacy ; ne pas renvoyer depuis BullMQ une notification appartenant à un run Temporal ; une issue inconnue est réconciliée, pas rejouée |

## Coexistence contrôlée

Les phases suivantes sont appliquées flux par flux. Leur ordre est impératif : **shadow dispatch → dual-read comparison → Temporal authoritative → legacy read-only → removal**.

### 1. Shadow dispatch

BullMQ reste autoritaire et seul propriétaire des effets externes pour les runs existants. Le shadow Temporal reçoit les mêmes entrées et calcule le dispatch, le graphe, les retries et les effets qu’il *proposerait*. Ces intentions sont journalisées avec le `run_id` de corrélation.

Toute activité à effet est remplacée par un enregistrement d’intention ou un fake en environnement isolé. Le shadow n’a pas de credentials de production pour GitHub, déploiement, Plane ou notifications. Un run CLI n’est pas doublé contre une branche ou une preview partagée : les tests de driver utilisent un worktree jetable et des sorties factices, sans publication. Les lectures strictement nécessaires sont permises si elles ne modifient ni état ni quota réservé.

**Sortie :** correspondances d’identifiants complètes, intentions comparables, effets externes shadow égaux à zéro et mécanisme de fencing testé.

### 2. Dual-read comparison

BullMQ reste l’autorité d’exécution. Les projections legacy et Temporal sont lues en parallèle et comparées dans Postgres. Cette phase ne signifie pas double écriture : seule l’activité déjà autorisée par BullMQ peut écrire à l’extérieur ; Temporal alimente sa projection candidate.

La comparaison porte sur work item, stage fonctionnel, révision, résultat terminal, références d’artefacts, PR/déploiement attendu et compte d’effets. Les identifiants techniques et timestamps différents sont réconciliés par une table de correspondance, pas ignorés arbitrairement. Toute divergence non expliquée bloque la bascule et remet la période d’observation à zéro pour le flux.

**Sortie :** sept jours consécutifs sans divergence d’état et scénarios de reprise/idempotence réussis.

### 3. Temporal authoritative

La bascule se fait à une frontière de run, jamais en déplaçant un job BullMQ actif :

1. empêcher de nouveaux dispatches legacy pour le périmètre candidat ;
2. laisser les jobs legacy actifs se terminer ou les classer explicitement non migrés ;
3. enregistrer la nouvelle génération et `authority = temporal` dans le registre ;
4. vérifier que les workers legacy respectent le fence ;
5. ouvrir les nouveaux starts Temporal, qui deviennent seuls propriétaires des effets de ces runs.

BullMQ reste autoritaire uniquement pour les runs explicitement non migrés. Les lectures et exports restent possibles, mais un ancien callback ne peut pas franchir le fence. Les effets reprennent après réconciliation par clé ; aucun merge/deploy n’est relancé sur simple timeout.

**Sortie :** le flux sert son trafic autorisé via Temporal sans recours opérationnel à BullMQ, tandis que les runs legacy restants sont traqués séparément.

### 4. Legacy read-only

Cette phase commence pour un flux lorsqu’il n’a plus aucun job actif, delayed, retryable ou répétable autoritaire. Les producers et consumers BullMQ du flux sont arrêtés ; les schedules et callbacks d’écriture sont désactivés. Les files, événements et artefacts restent consultables. Aucune purge n’accompagne ce passage.

**Sortie :** aucun chemin de code ne peut dispatcher ou exécuter un nouvel effet legacy pour le flux, et les exports de consultation sont vérifiés.

### 5. Removal

Le retrait technique est une décision distincte, postérieure aux étapes A–F et soumise au gate humain R3. Il exige les prérequis et exports de [legacy-systems.md](legacy-systems.md). L’arrêt d’un worker, la désinstallation d’un package, la suppression d’une file et la suppression de données sont quatre actions séparées ; la première n’implique jamais les autres.

## Critères de bascule par flux

Tous les critères suivants sont requis avant `Temporal authoritative` :

- **Sept jours consécutifs sans divergence d’état** sur le trafic représentatif du flux, avec rapport quotidien des comparaisons et zéro divergence inexpliquée ;
- **zéro double effet externe**, notamment zéro double PR, merge, deploy, mise à jour Plane ou notification ; le journal d’effets est comparé aux fakes/providers de test et aux objets réels du seul système autoritaire ;
- **reprise après redémarrage démontrée** par arrêt brutal puis redémarrage du worker pendant une activité et pendant une attente ; l’historique reprend sans nouveau run CLI ni effet dupliqué ;
- **attente d’un signal sans worker occupé** : `waiting_decision`, webhook et timer libèrent le worker et tout processus CLI inactif ; la métrique de workers occupés et les processus du node le confirment ;
- **idempotence et réconciliation démontrées** sur les signaux dupliqués et les issues externes inconnues, avec les clés propres au flux ;
- **tests obligatoires de l’inventaire réussis**, traces et manifests rattachés au work item ou au cycle ;
- **rollback du flux répété en environnement isolé**, y compris la preuve qu’un run Temporal n’est pas rouvert dans BullMQ.

Une divergence, un effet dupliqué ou un test de reprise en échec interdit la bascule. Les sept jours d’observation repartent après correction et nouvelle preuve, pas après simple revue du code.

## Protocole de tests

Les tests utilisent un serveur Temporal de test, des files BullMQ isolées et des adaptateurs Plane/GitHub/deploy/notifications contrôlés. Les tests de bout en bout sur environnement partagé conservent une seule autorité d’écriture. Chaque scénario enregistre `run_id`, génération, clés d’idempotence et nombre d’effets reçus par les fakes.

| Scénario commun | Injection | Assertion minimale |
|---|---|---|
| Unicité d’autorité | Deux dispatches avec la même identité métier et deux générations successives | Un seul workflow autoritaire ; l’ancienne génération est refusée ; aucun effet shadow |
| Crash avant réponse externe | Arrêt du worker après envoi au fake, avant enregistrement du résultat | Réconciliation par clé, puis un seul effet constaté |
| Signal dupliqué/en retard | Rejouer le même `event_id` et un signal d’une révision précédente | Aucun nouvel effet ; aucune révision supplémentaire |
| Attente durable | Entrer en `waiting_decision`, attendre, puis signaler | Aucun worker/CLI occupé pendant l’attente ; reprise sur le bon run |
| Redémarrage | Tuer le worker pendant chaque type d’activité critique | Historique et artefacts conservés ; reprise sans double effet |
| Coexistence | Faire cohabiter un run migré et un run legacy non migré du même flux | Chacun reste sur son autorité ; aucun partage de callback ne change cette autorité |
| Rollback | Déclencher un rollback pendant le shadow et pendant la coexistence | Nouveaux dispatches Temporal arrêtés ; seuls les runs non migrés reprennent legacy |

## Rollback opérationnel

Le rollback est local à un flux. Il ne consiste pas à recharger l’état Temporal dans Redis.

1. **Arrêter les nouveaux dispatches Temporal** du flux : pause des Schedules et refus des nouveaux starts, sans annuler aveuglément les workflows actifs.
2. **Geler les effets incertains** si une duplication est suspectée. Réconcilier GitHub, Plane, déploiement ou notification par clé avant toute reprise. Un double merge/deploy est un incident avec gate humain, pas un simple retry.
3. **Conserver les runs Temporal autoritaires dans Temporal**. Leur attente, reprise, compensation et rollback de release suivent les workflows Temporal existants.
4. **Reprendre la file legacy uniquement pour les runs non migrés**, après vérification du registre et des fences. Les jobs legacy actifs ne sont ni clonés ni rejoués dans Temporal.
5. **Rétablir séparément chaque routine legacy non migrée**, en vérifiant qu’aucun Schedule Temporal ou cron CLI équivalent n’est actif.
6. **Conserver tous les journaux et artefacts**, publier la cause, puis refaire les tests et la période de sept jours avant une nouvelle tentative.

Pour un rollback depuis `legacy read-only`, il n’existe par définition aucun run migré à rouvrir dans BullMQ. Toute réactivation exceptionnelle concerne uniquement un flux dont l’autorité n’a jamais été transférée ; sinon elle exige une nouvelle décision d’architecture et ne fait pas partie de cette procédure.

## Alignement avec les étapes A–F

- **A — ExecutionAdapter :** tester les mêmes `RunSpec` et événements sans publier deux fois ; les anciens drivers restent disponibles pour comparaison isolée.
- **B — Temporal :** migrer les premiers flux avec les gates ci-dessus ; ne plus ajouter de workflow durable BullMQ.
- **C — Runner hybride :** vérifier qu’une reconnexion ou un fallback ne crée pas un second run ou effet.
- **D — ExperienceWorkflow :** conserver les exports historiques et ne rendre AFFiNE, Storybook ou Penpot ni obligatoires ni autoritaires.
- **E — Delivery probant :** prouver une seule chaîne d’effets de la demande à la release.
- **F — Estimation et routage :** comparer les métriques dans Postgres sans transformer pgvector en autorité ni purger les historiques.

Le retrait de BullMQ et des autres systèmes legacy ne fait partie d’aucune de ces étapes.
