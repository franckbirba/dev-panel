# DevPanel — Architecture de l’usine logicielle agentique

**Date :** 2026-11-02
**Statut :** architecture validée oralement, en attente de revue écrite
**Cible initiale :** studio multi-projets opéré par Franck, sans exigence multi-tenant

## 1. Contexte

DevPanel possède déjà une API, un dashboard, des captures, Plane, GitHub, Postgres, BullMQ, des worktrees et plusieurs drivers d’agents. En pratique, l’exécution reste moins utile que les tâches planifiées natives de Claude Code et Kimi Code : les agents demandent trop d’interventions, les workflows ne couvrent pas tout le delivery, les artefacts de conception ne sont pas fiables et les métriques ne permettent pas une prévision crédible.

Les demandes arrivent par plusieurs canaux et peuvent être perdues. Les estimations d’agents sont instables. AFFiNE et le Storybook global n’ont pas trouvé leur place dans le fonctionnement réel. Plane, en revanche, est effectivement utilisé et obligatoire dans les hooks de PR.

Le produit doit devenir l’implémentation logicielle des processus d’une usine de développement : intake, roadmap, spécification, conception, exécution, validation, release, observation et amélioration continue.

## 2. Résultat attendu

Une demande doit pouvoir suivre ce parcours avec un minimum d’interventions humaines :

```text
Demande originale
  → qualification
  → work item Plane
  → spécification
  → prototype éventuel
  → implémentation
  → preuves de validation
  → release
  → demande originale mise à jour
```

Les exigences structurantes sont :

- plusieurs projets pilotés depuis une interface ;
- orchestration durable 24/7, y compris lorsque les exécutants locaux sont déconnectés ;
- Claude Code et Kimi Code exécutés comme **processus CLI**, sans appel direct de DevPanel aux API Anthropic ou Moonshot ;
- routage premium/économique fondé sur la qualité mesurée et le coût ;
- prototypes et décisions historisés avec le code ;
- estimation explicite de complexité et de durée, distinguée de la date de livraison prévisionnelle ;
- aucun faux `done` : une étape avance sur des artefacts et des preuves, pas sur une déclaration d’agent.

## 3. Non-objectifs de cette architecture

- Réécrire DevPanel comme un IDE ou un concurrent d’Orca.
- Faire d’OpenCode le runtime obligatoire ou appeler les modèles via leurs API fournisseurs.
- Automatiser l’interface graphique bêta de Kimi Design dans le chemin critique de production.
- Introduire une gestion multi-tenant, des permissions d’équipe complexes ou une facturation SaaS.
- Conserver AFFiNE, Storybook ou Penpot comme passages obligés.
- Ajouter du machine learning pour les prévisions avant d’avoir épuisé les méthodes empiriques explicables.

## 4. Décisions d’architecture

| Domaine | Décision |
|---|---|
| Produit, roadmap, cycles, work items | **Plane** est l’autorité produit |
| Code, PR, specs, ADR et décisions | **GitHub et les repos Git** |
| Orchestration durable | **Temporal**, auto-hébergé |
| Exécution | Drivers de processus CLI derrière un `ExecutionAdapter` |
| Exécution hybride | Workers cloud et runner local sur les machines disponibles |
| Design premium | Claude Code / Claude Design selon les fonctions natives disponibles |
| Design économique | Kimi Code HTML headless et Kimi Design via un bridge local |
| Prototypes | Code HTML/React exécutable et preview de la vraie application |
| Validation UI | Playwright, screenshots, parcours et traces |
| Artefacts lourds | Stockage S3 compatible, MinIO dans le déploiement interne |
| Événements et analytics | Postgres DevPanel |
| Specs et décisions | Markdown/YAML versionnés dans le repo du projet |
| OpenCode | Driver optionnel, jamais dépendance centrale |
| Orca | Console opérateur optionnelle, jamais fondation du produit |
| AFFiNE | Retrait du chemin critique, sans suppression initiale des données |
| Storybook global | Remplacement par les previews applicatives |
| Penpot | Outil optionnel pour un workflow designer/client |
| BullMQ | Transition uniquement ; aucun nouveau workflow durable |
| pgvector | Index de recherche optionnel, jamais preuve ni vérité |

## 5. Vue d’ensemble

![Architecture de l’usine logicielle agentique](./agentic-dev-factory-architecture.svg)

Vues interactives : [architecture globale](../../architecture/diagrams/solution.html) et [chaîne de traçabilité](../../architecture/diagrams/traceability.html).

```text
Canaux clients / captures / Plane
                 │
                 ▼
        DevPanel Control Plane
        ├── API et dashboard
        ├── projections Postgres
        ├── politiques d’autonomie
        └── routage coût / qualité / capacité
                 │
                 ▼
              Temporal
        ├── DeliveryWorkflow
        ├── ExperienceWorkflow
        ├── BuildWorkflow
        ├── ReleaseWorkflow
        ├── durable timers et schedules
        └── task queues cloud / locales
                 │
        ┌────────┴─────────┐
        ▼                  ▼
 Workers cloud        Runner local PC
 ├── Claude CLI       ├── Claude CLI
 ├── Kimi CLI         ├── Kimi CLI
 ├── OpenCode         ├── KimiDesignBridge
 ├── tests            ├── outils locaux
 └── release          └── exports design
        │                  │
        └────────┬─────────┘
                 ▼
       GitHub / MinIO / Postgres
```

Le cloud est l’autorité de coordination. Le PC local est une capacité spécialisée et interchangeable, pas un point unique de défaillance.

## 6. Autorités et sources de vérité

Il n’y a pas une base unique pour tous les domaines, mais une autorité non ambiguë par domaine.

- **Plane** : périmètre produit, priorité, roadmap, cycle et statut produit du work item.
- **Git** : code, spec implémentée, prototype source, ADR et décision versionnée.
- **Temporal** : état technique d’une exécution, attentes, timers, signaux et reprises.
- **Postgres DevPanel** : événements normalisés, read models, métriques et liens entre artefacts.
- **MinIO/S3** : screenshots, traces, vidéos, exports de sessions et autres fichiers lourds.

Plane ne porte pas les états techniques détaillés des runs. DevPanel ne construit pas une roadmap concurrente. Temporal est le seul service qui décide de la reprise technique d’une activité.

## 7. Processus de delivery

### 7.1 États fonctionnels

```text
intake
→ discovery
→ specification
→ experience (si UI/UX)
→ ready
→ build
→ verify
→ review
→ release
→ observe
→ done
```

Les retours en arrière sont explicites. Un échec de review ou de QA crée une révision et alimente les métriques de rework.

### 7.2 Definition of Ready

Un work item est `ready` lorsqu’il possède :

- la demande et sa provenance ;
- un identifiant Plane ;
- le problème, les utilisateurs et le hors-périmètre ;
- des critères d’acceptation testables ;
- les dépendances et la classe de risque ;
- une estimation de complexité et ses hypothèses ;
- une stratégie de vérification ;
- une `PrototypeRelease` pour tout travail UI significatif ;
- une politique d’exécution et un budget.

Un `XL` est découpé. Une incertitude majeure produit d’abord un spike limité.

### 7.3 Definition of Done

Un work item est `done` lorsque :

- la PR est fusionnée ;
- les vérifications requises sont vertes ;
- la release est déployée ;
- les health checks et le rollback sont connus ;
- les preuves sont rattachées au work item ;
- la demande originale est mise à jour ;
- les mesures réelles sont enregistrées.

## 8. Temporal et scheduling

Temporal porte les processus longs : attente d’une PR, reprise après incident, décision humaine, timers, branches parallèles, webhooks et compensations.

### 8.1 Répartition

| Besoin | Mécanisme |
|---|---|
| Ingestion, synchronisation Plane, rapports récurrents | Temporal Schedules |
| Attente d’un événement ou d’une décision | Timers et signals Temporal |
| Retry d’une activité | Retry Policy de l’activité |
| Rappel local dans une session Kimi/Claude | Cron natif du CLI |
| Action critique de production | Temporal uniquement |

Les crons natifs des CLI ou de l’app Kimi ne sont pas des schedulers globaux. Une action ne doit jamais être programmée à la fois dans Temporal et dans un scheduler natif.

### 8.2 Jobs courts et notifications

Les jobs courts sont progressivement exécutés comme activités Temporal. BullMQ reste uniquement pendant la migration, puis est retiré si aucune dépendance résiduelle ne le justifie.

## 9. Contrat d’exécution CLI

### 9.1 Interface

```text
ExecutionAdapter
  capabilities(driver) → CapabilitySet
  start(RunSpec)       → RunHandle
  stream(run_id)       → ExecutionEvent[]
  resume(run_id, input)
  cancel(run_id)
  export(run_id)       → ExecutionExport
```

Implémentations initiales :

- `ClaudeCodeCliDriver` ;
- `KimiCodeCliDriver` ;
- `OpenCodeCliDriver` optionnel.

Kimi est lancé avec son mode non interactif et `stream-json`. Claude conserve le même principe. DevPanel ne contient aucun SDK Anthropic ou Moonshot pour exécuter les modèles.

### 9.2 RunSpec

Chaque run contient :

- `run_id`, `work_item_id`, `workflow_run_id`, `stage` ;
- repo, `base_sha`, branche et worktree ;
- instructions et versions des artefacts d’entrée ;
- driver et capacités requises ;
- outils et permissions ;
- politique de coût, durée et fallback ;
- critères de sortie et schéma des artefacts ;
- politique d’autonomie et classe de risque.

### 9.3 Capacités natives

Le contrat normalise le cycle de vie et les événements, sans réduire les CLI à leur plus petit dénominateur commun. Les capacités déclarent notamment `resume`, `cron`, `goal`, `design`, `multimodal` et `permissions`.

Temporal choisit un driver compatible avec les capacités requises. Une fonction spécifique à un fournisseur reste accessible sans devenir une exigence pour les autres.

## 10. Exécution hybride cloud/local

### 10.1 Runner local

Le runner local est un worker Temporal standard complété par un agent d’artefacts. Il établit uniquement des connexions sortantes sécurisées vers Temporal, DevPanel et MinIO. Aucun port entrant n’est requis.

Il annonce ses capacités, par exemple :

```json
{
  "node": "macbook-franck",
  "capabilities": [
    "cli.claude-code",
    "cli.kimi-code",
    "design.kimi-app",
    "browser.local",
    "filesystem.local"
  ]
}
```

### 10.2 Routage

Une activité déclare `capability`, `placement`, `fallback`, `deadline` et les artefacts attendus.

- `local` : attend une machine locale compatible ;
- `cloud` : ne doit jamais dépendre du PC ;
- `preferred-local` : privilégie le local puis applique le fallback ;
- `any` : choisit selon coût, disponibilité et sensibilité des données.

Lorsque le PC est éteint, l’activité reste en attente sans échec. À sa reconnexion, le runner consomme l’activité et le workflow reprend.

Les politiques de fallback sont `wait`, `cloud_fallback`, `escalate` et `deadline`. Toutes les exécutions utilisent une clé d’idempotence et des heartbeats.

### 10.3 Sécurité locale

- credentials et sessions Kimi/Claude conservés localement ;
- accès limité aux répertoires autorisés ;
- upload MinIO par URLs présignées ;
- dashboard exposant état du node, capacités, heartbeat et run courant ;
- aucune action locale sans journalisation de son `run_id`.

## 11. Experience et prototypage

### 11.1 Distinction des produits Kimi

Kimi Code CLI et Kimi Design sont deux produits distincts. Kimi Design appartient à l’application Kimi grand public. Aucun accès CLI ou API public documenté n’est retenu dans cette architecture.

### 11.2 Drivers de design

| Driver | Fonction | Niveau d’automatisation |
|---|---|---|
| `ClaudeDesignDriver` | Design premium et prototypes structurants | Claude Code et fonctions natives disponibles |
| `KimiCodeHtmlDriver` | Prototypes HTML/React économiques | Headless via `kimi -p` |
| `KimiDesignBridge` | Utilisation de Kimi Design dans l’app Kimi | Semi-automatisée au départ |

`KimiDesignBridge` prépare le `DesignBrief`, attend la génération dans l’app Kimi, surveille ou reçoit l’export, puis reprend le workflow. Une future API officielle pourra remplacer ce bridge sans modifier le processus Temporal.

L’automatisation visuelle de l’app Kimi est expérimentale et exclue du chemin critique.

### 11.3 ExperienceWorkflow

```text
DesignBrief
  → sélection d’un driver capable de design
  → génération et itérations
  → preview exécutable
  → captures desktop/mobile
  → quality gate
  → PrototypeRelease immuable
```

Le prototype utilise les vrais tokens et composants du projet dès qu’ils sont disponibles. Il couvre les parcours, les breakpoints et les états vide, chargement, erreur et succès.

### 11.4 PrototypeRelease

```text
plane_work_item_id
prototype_version
source_format
source_location
source_sha
preview_url
design_system_sha
screenshots[]
user_flows[]
supported_states[]
decisions[]
native_session_ids[]
created_by
created_at
```

Le Builder reçoit une version précise du prototype, jamais une référence implicite à « la dernière version ».

### 11.5 Benchmark et routage qualité/coût

Le routage ne présume pas qu’un modèle est toujours supérieur. Claude Design, Kimi Design, Kimi Code HTML, OpenCode/Qwen et OpenCode/DeepSeek sont comparés sur les mêmes briefs : dashboard dense, CRUD, onboarding, formulaire complexe, responsive et états limites.

La notation couvre design system, UX, qualité visuelle, états, accessibilité, réutilisabilité du code et effort d’itération. Les mesures incluent coût, durée, allers-retours et minutes humaines.

Claude est le driver premium pour les décisions structurantes et le design à fort enjeu. Les autres drivers sont choisis par classe de work item selon leurs résultats. Un échec du quality gate entraîne une itération ou une escalade de driver.

## 12. Historisation et réponse à « pourquoi avons-nous fait ça ? »

La chaîne obligatoire est :

```text
Demande originale
→ Plane work item
→ spec versionnée
→ PrototypeRelease
→ DecisionRecord
→ PR / commits
→ release
```

Structure dans chaque repo :

```text
docs/work-items/<PLANE-ID>/spec.md
docs/work-items/<PLANE-ID>/decisions/<DECISION-ID>.yaml
prototypes/<PLANE-ID>/
```

Un `DecisionRecord` contient : contexte, options, choix, justification, conséquences, décision remplacée, références aux SHA, auteur, driver, session native et date.

Les sources et décisions sont versionnées dans Git. Les exports lourds sont dans MinIO. Postgres indexe les liens pour la recherche. pgvector peut aider à retrouver les références, mais la réponse doit toujours citer les artefacts immuables.

## 13. Estimation et prévision

Trois concepts restent séparés :

1. **Complexité** : `XS/S/M/L/XL`, fondée sur modules, intégrations, états UI, incertitude, dépendances, données, sécurité, tests et réversibilité.
2. **Durée active estimée** : travail effectif `P50/P80`, avec hypothèses, inconnues, confiance et références historiques.
3. **Date de livraison prévisionnelle** : durée active, attente, dépendances, rework et capacité.

### 13.1 Prévision empirique

Le système recherche les work items comparables par `projet + type + taille`, puis élargit si nécessaire à `type + taille`, puis à `taille`. Il mesure les distributions réelles de durée par étape, attente, rework, blocage et release.

Les simulations respectent le graphe de dépendances et les limites de capacité. Elles produisent `P50/P80/P95`. Aucun ML n’est requis initialement.

L’estimation de l’agent, la prévision système et le réel sont tous conservés. Leur écart permet de mesurer le biais et la performance par driver, rôle et type de tâche.

## 14. Métriques

Les événements alimentent :

- lead time : demande reçue → déployée ;
- cycle time : ready → déployée ;
- temps actif contre temps d’attente ;
- throughput par classe de work item ;
- first-pass yield et taux de rework ;
- blocages et interventions humaines par livraison ;
- coût par work item accepté ;
- qualité et coût par driver/modèle/version ;
- précision des estimations et calibration des prévisions.

Le dashboard ne compte comme vélocité que les éléments effectivement déployés et acceptés.

## 15. Autonomie et sécurité

L’autonomie dépend du risque, pas d’un mode YOLO global.

- Modifications locales, tests, branches, commits et draft PR : automatiques.
- Previews, retries et fallback de driver : automatiques et journalisés.
- Merge et production : automatiques uniquement si la classe de risque, les preuves et le rollback l’autorisent.
- Auth, secrets, destruction de données, facturation et communication client : gate humain.

Les exécutants cibles sont isolés par worktree et conteneur, avec réseau non partagé, egress limité, credentials temporaires et scoped, ressources bornées et outils audités. Les permissions globales `--dangerously-skip-permissions` et le partage du réseau hôte ne font pas partie de l’architecture cible.

Une question humaine est un état durable `waiting_decision`, jamais un worker endormi occupant inutilement la capacité.

## 16. Gestion des erreurs

- Activité technique : retry Temporal borné et adapté à la cause.
- Erreur de parsing ou contrat : échec de l’activité, sans transition de delivery.
- Driver indisponible : fallback seulement si la capacité et la politique le permettent.
- PC local absent : attente ou fallback, jamais échec immédiat.
- Quality gate insuffisant : révision ou escalade de driver.
- Artefact absent ou non conforme : étape incomplète.
- Effets externes : clés d’idempotence et références de run systématiques.
- Épuisement du budget : état durable et décision explicite, pas de retry aveugle.

## 17. Vérification de l’architecture

### Tests de contrat

- Même `RunSpec` sur chaque driver CLI.
- Reprise, annulation, export et capacités.
- Absence d’appel direct aux API modèles.
- Validation des schémas `PrototypeRelease` et `DecisionRecord`.

### Tests Temporal

- Reprise après redémarrage du worker.
- Attente d’un signal sans consommation de worker.
- Timer, retry, fallback et idempotence.
- PC offline puis réconciliation à la reconnexion.

### Tests de bout en bout

- Demande backend jusqu’à release.
- Feature UI avec prototype, screenshots, décisions et build.
- Trois projets concurrents avec limites de capacité.
- Échec d’un driver et escalade sans duplication des effets.

### Benchmark design

Même jeu de briefs et mêmes entrées pour chaque candidat, revue aveugle de la qualité, vérifications Playwright et enregistrement du coût complet.

## 18. Migration par preuves successives

### Étape A — ExecutionAdapter

`ClaudeCodeCliDriver` et `KimiCodeCliDriver` produisent les mêmes événements et artefacts sur un jeu de tâches représentatif, sans appel API direct.

### Étape B — Temporal

Un workflow complet reprend après redémarrage, attend une décision sans bloquer un worker et évite tout double effet. Les nouveaux workflows ne sont plus ajoutés à BullMQ.

### Étape C — Runner hybride

Une activité locale attend le PC hors ligne, reprend à sa connexion et téléverse ses artefacts sans intervention de resynchronisation.

### Étape D — ExperienceWorkflow

Une feature UI reçoit une `PrototypeRelease`, des preuves Playwright et des décisions versionnées avant le build.

### Étape E — Delivery probant

Une demande originale arrive jusqu’à une release avec sa chaîne de traçabilité complète.

### Étape F — Estimation et routage mesuré

Les prévisions utilisent les historiques réels et le routage design s’appuie sur le benchmark qualité/coût.

Chaque étape possède sa propre spécification et son plan d’implémentation. Elles ne sont pas livrées comme un big bang.

## 19. Hypothèses retenues

- Plane reste obligatoire dans les hooks de PR.
- Temporal est auto-hébergé avec sa propre base sur le serveur Postgres existant.
- Le runner local est optionnel pour le fonctionnement global du cloud.
- Kimi Design ne dispose pas, dans les sources vérifiées, d’une CLI ou API publique documentée ; le bridge local est donc semi-automatisé au départ.
- Kimi Code CLI reste un driver important et économique, indépendamment de Kimi Design.
- Claude est réservé aux travaux où sa qualité justifie son coût.
- Les utilisateurs initiaux sont Franck et ses agents ; l’authentification multi-équipe est hors périmètre.
- Les données AFFiNE et Storybook existantes ne sont pas supprimées pendant la migration ; ces services quittent simplement le chemin critique.
