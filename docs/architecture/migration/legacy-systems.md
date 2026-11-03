# Sortie des systèmes legacy

## Objet et interdictions

Ce document définit les prérequis de retrait d’AFFiNE, du Storybook global, de pgvector, de Penpot, de BullMQ et des anciens drivers. Il applique la [spec d’architecture](../../superpowers/specs/2026-11-02-agentic-dev-factory-architecture-design.md), les ADR [0001](../adr/0001-temporal-durable-orchestration.md), [0003](../adr/0003-cli-only-agent-execution.md), [0005](../adr/0005-git-versioned-product-artifacts.md) et [0006](../adr/0006-retire-affine-and-global-storybook.md).

**Aucune suppression de données n’est autorisée pendant les étapes A–F.** Cette interdiction couvre documents, attachments, stories, captures, index et embeddings, fichiers design, jobs/files BullMQ, exports de sessions, journaux et artefacts. Un export est une copie vérifiée, jamais un déplacement qui supprime la source. Le passage hors du chemin critique, le mode read-only, l’arrêt d’un service et la suppression de ses données sont des décisions distinctes.

Pendant les étapes A–F, aucun mécanisme legacy ou de remplacement ne peut produire un second effet externe pour le même run. Les exports et restaurations de test utilisent un environnement isolé et ne mettent pas à jour Plane, GitHub, un déploiement ou un client en double.

## Propriété des décisions et autorités cibles

Franck, propriétaire produit et opérateur initial de DevPanel, est le décideur humain final pour toute suppression, classée R3. Le maintainer responsable du domaine prépare le dossier, exécute les vérifications et atteste les résultats ; il ne peut pas s’auto-approuver une suppression. Le nom de l’approbateur, la date, le périmètre exact, les exports et le résultat de restauration sont consignés dans un `DecisionRecord` avant toute action destructive ultérieure.

Les remplacements ne changent pas les autorités :

- Plane reste autoritaire pour le produit, la roadmap, les cycles et les statuts ;
- Git/GitHub pour les specs, décisions, prototypes sources, code et PR ;
- Temporal pour l’état technique d’exécution après bascule ;
- Postgres DevPanel pour les read models et analytics, jamais pour les preuves sources ;
- MinIO/S3 pour les fichiers lourds, avec `ArtifactManifest` et SHA-256 ;
- les previews applicatives et Playwright pour les preuves UI ;
- `ExecutionAdapter` et les drivers CLI vérifiés pour l’exécution d’agents.

## Matrice de retrait

| Système | Rôle résiduel pendant A–F | Prérequis de retrait | Export à conserver | Propriétaire de la décision de suppression | Critère final |
|---|---|---|---|---|---|
| AFFiNE | Consultation historique uniquement ; aucune autorité produit et aucune étape obligatoire de spec/décision | Inventaire des documents, liens et attachments terminé ; nouvelles specs/décisions dans Git et work items dans Plane ; aucun workflow actif ne lit ou écrit AFFiNE ; export et restauration vérifiés | Export natif/Markdown de chaque document, attachments originaux, identifiants, titres, dates, tags/liens, correspondances Plane/Git et manifest SHA-256 | Franck sur dossier du maintainer documentation/produit ; gate R3 séparé | Plus aucune dépendance active ; chaque référence retenue se résout dans Plane/Git/MinIO ; échantillon représentatif restauré et relu ; source historique encore intacte au moment de la décision |
| Storybook global | Référence visuelle historique ; aucune preuve UI obligatoire | Les parcours retenus sont couverts par previews de la vraie application et prototypes exécutables ; vérifications Playwright, viewports et états requis enregistrés ; aucun build/release n’exige Storybook | Sources et configuration avec SHA Git, versions/addons, build statique daté, screenshots utiles, correspondances stories → parcours/preuves et manifest | Franck sur dossier du maintainer frontend ; gate R3 séparé | CI et delivery verts sans Storybook global ; couverture des scénarios retenus démontrée dans l’application ; archive statique ouverte et liens vérifiés |
| pgvector | Index de recherche optionnel et reconstruisible ; jamais preuve ni source de vérité | Toutes les réponses citent Git/Plane/MinIO/Postgres source ; aucun run ne dépend de l’index pour avancer ; reconstruction ou recherche de remplacement testée ; dépendances applicatives inventoriées | Schéma/version/extension, modèle et dimensions d’embedding, tables de correspondance `source_ref`/SHA, configuration d’index, export `pg_dump` du périmètre retenu et manifest | Franck sur dossier du maintainer data/platform ; gate R3 séparé | Recherche et citations acceptées sans l’ancien index, ou reconstruction à l’identique depuis les sources ; aucun artefact source ne dépend de sa présence |
| Penpot | Outil optionnel designer/client ; aucun passage obligé et aucune automatisation GUI critique | Work items actifs ne requièrent plus Penpot ; décisions et sources retenues converties en prototypes HTML/React Git et `PrototypeRelease` ; exports lourds et preuves dans MinIO ; validation du designer/client pour ses fichiers | Fichier Penpot natif, exports SVG/PNG et autres exports sources disponibles, tokens/composants associés, commentaires/décisions retenus, correspondances Plane/Git et manifest SHA-256 | Franck sur dossier du responsable design, avec accord du propriétaire des fichiers client le cas échéant ; gate R3 séparé | Aucun chemin critique ou contrat client ne l’exige ; chaque prototype retenu possède `source_sha`, preview et screenshots ; export rouvert et vérifié hors service |
| BullMQ | Orchestration uniquement des runs legacy non migrés, puis consultation read-only ; aucun nouveau workflow durable | Chaque flux a suivi [la migration Temporal](bullmq-to-temporal.md), sept jours sans divergence et critères de bascule ; aucun job actif/delayed/retryable/repeatable autoritaire ; producers/consumers et crons legacy arrêtés ; aucun enqueue résiduel ; exports restaurables | Inventaire queues/workers/producers, repeatable jobs et configuration, états des jobs et erreurs, correspondances `legacy_job_id` ↔ `workflow_id`, clés d’idempotence et journaux retenus ; export Redis/`pg_dump` selon stockage effectif | Franck sur dossier du maintainer orchestration ; gate R3 séparé | Tous les flux sont Temporal authoritative puis legacy read-only ; test prouve qu’aucun chemin ne peut enqueue/exécuter ; reprise Temporal et absence de double effet vérifiées ; archive consultable |
| Anciens drivers | Exécution des runs non migrés et accès historique aux sessions pendant l’adaptation CLI ; aucun nouvel appel direct aux API modèles | `ClaudeCodeCliDriver` et `KimiCodeCliDriver` derrière `ExecutionAdapter` couvrent les capacités requises ; mêmes `RunSpec` testés ; start/stream/resume/cancel/export vérifiés par version ; runs legacy terminés ; aucune capacité non vérifiée supposée | Versions/configuration non secrète, matrice de capacités et résultats de contrat, correspondances `run_id`/sessions natives, exports de sessions et artefacts dans MinIO avec manifests ; aucun credential ni secret | Franck sur dossier du maintainer exécution ; gate R3 séparé pour données ou credentials | Aucun run actif ni enregistrement de node n’utilise l’ancien driver ; tests Claude/Kimi et absence d’appel API direct verts ; sessions et preuves retenues rouvertes depuis leurs exports |

Les retraits sont indépendants : la sortie d’AFFiNE n’autorise pas celle de Penpot, et la disparition d’un index pgvector n’autorise aucune purge des artefacts indexés.

## Dossier de preuve par système

Avant même de proposer un arrêt définitif, le maintainer constitue un dossier contenant :

1. **Inventaire** : instances, versions, volumes, propriétaires, dépendances entrantes/sortantes et derniers usages ; aucune dépendance inconnue ne peut être déclarée absente par simple recherche de nom.
2. **Carte des autorités** : pour chaque donnée conservée, cible Plane, Git, Temporal, Postgres ou MinIO et identifiant de corrélation. Une projection n’est jamais promue source par commodité.
3. **Export immuable** : format, date, périmètre, nombre d’objets, taille, SHA-256, emplacement et identité de l’opérateur ; les secrets sont exclus des exports de drivers.
4. **Test de restauration** : restauration dans un environnement isolé, ouverture d’un échantillon représentatif, contrôle des liens et comparaison du nombre d’objets. Pour les fichiers binaires, les empreintes doivent correspondre ; pour les exports textuels, les références et pièces jointes sont relues.
5. **Preuve d’indépendance** : tests de delivery et scénarios métier réussis sans écriture legacy, avec zéro double effet externe. Pour BullMQ, les tests de la matrice de migration sont obligatoires ; pour Storybook, les preuves Playwright le sont.
6. **Décision séparée** : `DecisionRecord` et approbation R3 de Franck, après A–F, précisant si la décision porte sur arrêt, désinstallation, suppression d’infrastructure ou suppression de données.

Une exportation réussie ne déclenche pas automatiquement la suppression. Toute période de rétention et tout calendrier de destruction ultérieur font l’objet d’une décision explicite distincte ; ce plan n’en programme aucune.

## Séquençage pendant les étapes A–F

| Étape | Usage legacy autorisé | Preuve requise avant de continuer | Action interdite |
|---|---|---|---|
| A — ExecutionAdapter | Anciens drivers pour runs existants et comparaison isolée ; AFFiNE/Storybook/Penpot consultables | Contrats CLI, événements, artefacts et exports comparés sans double publication | Supprimer anciennes sessions ou drivers ; ajouter un appel direct aux API modèles |
| B — Temporal | BullMQ pour les seuls runs non migrés ; shadow Temporal sans effets | Reprise, attente sans worker, idempotence et fencing réussis | Double dispatch autoritaire ; purge de files/jobs ; nouveau workflow durable BullMQ |
| C — Runner hybride | Capacités locales existantes et sessions conservées | PC offline → attente, reconnexion → reprise, fallback sans second effet | Copier les credentials locaux dans le cloud ou supprimer les exports locaux |
| D — ExperienceWorkflow | AFFiNE, Storybook et Penpot comme références facultatives | `PrototypeRelease`, sources Git, previews et preuves Playwright complètes | Rendre un legacy obligatoire ou supprimer ses sources après export |
| E — Delivery probant | Consultation historique et BullMQ non migré seulement | Une demande aboutit à une release avec une seule chaîne d’autorité et de traçabilité | Deux chemins de merge/deploy/notification ; nettoyage destructif |
| F — Estimation et routage | pgvector comme index optionnel ; historiques pour comparaison | Métriques et réponses citent les artefacts sources ; index reconstruisible | Faire de pgvector une preuve ; supprimer les historiques utilisés par les métriques |

La sortie du chemin critique peut donc survenir pendant A–F, mais pas le retrait destructif. La phase `removal` de BullMQ et les suppressions analogues commencent seulement après F, sur dossier approuvé.

## Vérifications spécifiques avant retrait

### AFFiNE et Storybook

- Comparer le nombre de documents/stories inventoriés, exportés puis restaurés, avec les exceptions explicitement listées plutôt que silencieusement ignorées.
- Ouvrir les attachments et le build statique sans accès au service d’origine ; vérifier que les liens actifs ont une cible Plane/Git ou sont marqués historiques.
- Exécuter les scénarios UI retenus sur la vraie application aux viewports et états requis ; rattacher screenshots, traces et rapports par `ArtifactManifest`.
- Vérifier qu’aucun hook de PR, workflow ou health check n’exige une réponse d’AFFiNE ou du Storybook global.

### pgvector et Penpot

- Pour pgvector, reconstruire un index jetable depuis les références sources et comparer un jeu de requêtes avec citations ; vérifier surtout l’exactitude des sources retournées, pas seulement la similarité des scores.
- Arrêter l’accès en écriture à l’index dans un environnement de test et démontrer que delivery, preuves et métriques continuent.
- Pour Penpot, rouvrir le fichier natif exporté et contrôler les exports visuels ; vérifier que chaque prototype actif possède une source Git SHA-fixée et une `PrototypeRelease` indépendante.
- Obtenir l’accord du propriétaire des fichiers lorsqu’un design appartient à un client ; aucun export ne transfère cette propriété à DevPanel.

### BullMQ et anciens drivers

- Lister les jobs `active`, `waiting`, `delayed`, `failed`, `paused` et repeatables de chaque file ; aucun job autoritaire ne doit rester avant `legacy read-only`. Un job `failed` est exporté et réconcilié, pas supprimé pour faire vide la file.
- Désactiver producers et consumers en test, puis tenter un enqueue/callback avec une ancienne génération : l’opération doit être refusée et auditée, sans effet externe.
- Rejouer les crash tests des notifications, merges et deploys ; les fournisseurs contrôlés doivent compter un seul effet par clé.
- Exécuter le même `RunSpec` sur chaque driver CLI de remplacement et vérifier capacités déclarées, annulation, reprise, export et artefacts sur la version installée.
- Rechercher les enregistrements de nodes et configurations qui référencent encore un ancien driver ; les migrer sans effacer les correspondances historiques ni exporter de secrets.

## Critère de clôture commun

Un système est déclaré retiré seulement lorsque son chemin d’exécution est absent ou désactivé, que les tests d’indépendance sont verts, que les exports et restaurations sont vérifiés, et que la décision R3 distincte est enregistrée. Tant que l’un de ces éléments manque, son état reste `active`, `optional` ou `read-only`, jamais `removed`.

Même après cette clôture, les artefacts sources et historiques ne sont supprimés que si une décision de destruction explicite les nomme. Le présent document n’autorise aucune suppression pendant A–F et n’établit aucune suppression automatique après F.
