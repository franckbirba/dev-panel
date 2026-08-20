# Engine Contract — la spec du moteur devpanl

**Statut : DRAFT v1.1 — à valider par Franck avant tout build (Phase C).**
*(v1.1 : amendements §4.2, §6, §11 suite au requirement model-agnostic — ADR-004 v2. Le moteur ne doit jamais dépendre d'un comportement propre à Claude ; toutes ses exigences s'appuient sur le driver contract.)*
**Autorité : ce document prime sur le code. Une divergence code↔contrat est un bug du code.**

Réfs : audit 2026-08-18 (`docs/superpowers/plans/2026-08-18-devpanl-zeno-v2-readiness.md`), ADR-001→004.

---

## 1. Objet

Définir ce que le moteur (worker BullMQ + engine YAML + drivers) **garantit** : cycle de vie d'un job, sémantique d'échec, timeouts, budgets, annulation, reprise après crash, idempotence. Aujourd'hui ces sémantiques sont émergentes (elles résultent de l'interaction non spécifiée de 4 mécanismes) — c'est la cause racine du babysitting constaté d'avril à août.

**Non-objectifs :** DAG engine générique, exécution parallèle du même work item, multi-workspace Plane, scheduling prédictif.

## 2. Vocabulaire

| Terme | Définition | Source de vérité |
|---|---|---|
| **Work item** | Ticket Plane (UUID + sequence_id type ZENO-830) | Plane |
| **Workflow instance** | Une exécution d'un workflow YAML pour un work item | table `workflow_instances` (services) |
| **Step** | Une étape du YAML = un rôle d'agent (builder, reviewer, qa, pm…) | YAML `src/worker/workflows/*.yaml` |
| **Job** | Une exécution d'un step par le worker | BullMQ `devpanel-agents` |
| **Driver** | Le harness qui exécute l'agent (claude natif ; cf. ADR-004) | `spawnAgent` |
| **Worktree** | Checkout isolé par job : `<repo>/.devpanel-worktrees/<jobId>` | `worktree.js` |
| **Vague (wave)** | Sous-ensemble d'items dispatchables ensemble (cf. ADR-001) | table `waves` (à créer) |

## 3. Modèle d'états

### 3.1 Statuts de step (enveloppe agent — inchangé, canonisé)

Un agent termine toujours par une ligne JSON (contrat ADR-002) avec `status ∈ {done, blocked, failed}` :
- `done` — le travail du step est fait, les AC du step sont remplis.
- `blocked` — ambiguïté réelle ou dépendance manquante : il faut un humain ou un replan. **Pas un échec.**
- `failed` — l'agent a essayé et n'y arrive pas (tests rouges irréductibles, rejet reviewer…).

### 3.2 États d'instance (canonisés)

`running · awaiting_approval · awaiting_input · completed · failed · exhausted · cancelled`

(Le « blocked » n'existe qu'au niveau step/enveloppe — au niveau instance, une ambiguïté finit en `awaiting_input` après replan.)

- **Un seul état de succès : `completed`.** (Aujourd'hui `completed` ET `done` coexistent en base — migration + contrainte CHECK.)
- États live : `running`, `awaiting_approval`, `awaiting_input`. États terminaux : les cinq autres.
- **Anti-zombie :** toute instance live porte un `last_event_at`. Une instance live sans job BullMQ associé et sans événement depuis `STALE_INSTANCE_TTL` (défaut 24 h) est réconciliée en `failed`, `reason=stale_reconciled` (cf. §8). `fleet_status` n'affiche jamais comme "running" une instance qui ne satisfait pas ces invariants — les rows de mai encore "running" en août sont exactement le bug que cet invariant interdit.

### 3.3 Autorité d'écriture

**Le worker est le seul écrivain des états d'instance et de step.** Shelly, le dashboard et les MCP tools *demandent* (dispatch, cancel, approve) via API/queue — ils n'écrivent jamais un état directement.

## 4. Sémantique d'échec — la taxonomie qui remplace l'empilement actuel

### 4.1 Le problème constaté

Quatre mécanismes se superposent sans contrat : retries BullMQ (`attempts: 3`) × boucle de révision (`max_revisions: 3` du YAML) × workflow `replan` × rescue PR. Résultat observé le 11/08 : 3 builders × 3 attempts × 2 vagues = 18 exécutions payantes pour 3 items, zéro merge.

### 4.2 La règle : chaque échec appartient à UNE classe, chaque classe a UN mécanisme

| Classe | Détection | Mécanisme | Borne | Jamais |
|---|---|---|---|---|
| **infra_failure** — spawn impossible, clone/fetch/auth KO, worktree KO, API Plane down | erreur AVANT que l'agent produise du travail | retry BullMQ, backoff expo | **2 retries** | ne consomme jamais une révision ; ne relance jamais l'agent si du travail a commencé |
| **agent_failure** — enveloppe invalide (parseResult), timeout (§5), budget dépassé (§6), crash du driver | erreur PENDANT/APRÈS le travail | **zéro retry aveugle.** Exception unique : enveloppe invalide → **1 retry-with-feedback** (on renvoie à l'agent l'erreur de validation exacte + le schéma, une seule fois — les modèles plancher corrigent leur format au premier feedback, ADR-004 v2). Ensuite : rescue PR si diff non vide (`[needs-review]`), step `failed`, notification | 1 exécution + 1 feedback | re-exécuter à l'aveugle (token brûlé sur cause inconnue) |
| **quality_failure** — reviewer/qa rendent `failed` (ex. predicate `reviewer_rejected_pr`) | enveloppe valide, status=failed | boucle de révision YAML (`next: builder`) | `max_revisions: 3` puis `on_exhaustion: block` → `exhausted` | retry BullMQ |
| **ambiguity** — enveloppe `blocked` | l'agent le dit lui-même | workflow `replan` (PM) puis `awaiting_input` humain | 1 replan par step | boucler replan→replan |

**Implémentation normative :** BullMQ passe à `attempts: 1`. Les retries infra sont décidés par l'engine (qui sait classifier), pas par la queue (qui ne sait pas). C'est un changement de comportement délibéré.

### 4.3 Terminalité et notification

Toute arrivée dans un état terminal ou `awaiting_*` **notifie** (Telegram via `notifyJob`) avec : work item (sequence + titre), classe d'échec, raison en une phrase, et l'action possible (`relancer / voir la PR rescue / répondre au PM`). Les transitions step→step ne notifient pas (log seulement). Plus jamais de boucle silencieuse ni d'échec muet.

## 5. Stall, timeouts et taille des tâches (arbitré 2026-08-18)

**Le principe premier n'est pas le timeout, c'est la taille des tâches.** Un builder qui tourne 45–60 min sans retour est un défaut de découpage, pas un réglage : la boucle attribue des tâches **petites** (template agent-ready, ≤400 LOC) au pool d'agents, pour des itérations courtes et rapides. Le timeout est un filet, jamais un mode de fonctionnement.

- **Détection de stall — le vrai signal** : aucun événement du driver (tool call, texte) depuis `STALL_TIMEOUT_MS` (défaut **5 min**) → kill anticipé, classé `agent_failure` reason=stall, rescue si diff. L'incident historique « 1 h de run pour découvrir que l'agent n'a pas pu commit » se détecte désormais en ~5 min, diff partiel sauvé en rescue PR.
- **Wall-clock par rôle (filet)** : builder **20 min**, qa/reviewer/architect/merge-coordinator **15 min**, pm **10 min** — `AGENT_TIMEOUT_<ROLE>_MS` pour override ponctuel. Kill : SIGTERM → 30 s de grâce → SIGKILL, process group entier, worktree conservé pour rescue.
- Invariant : `lockDuration` BullMQ > max(timeout par rôle) + 5 min — le lock ne peut jamais expirer avant le kill (aujourd'hui inversé : lock 30 min < gros job → double-dispatch possible).
- **Un item qui déborde régulièrement du filet retourne au PM pour re-découpage** — pas d'augmentation silencieuse du timeout.

## 6. Budgets

- **Tokens par job**, comptés sur le stream du driver : `BUDGET_TOKENS_<ROLE>` — défauts : builder **200k**, qa **150k**, reviewer **100k**, autres **80k** (les seuils du SOUL de Shelly, enfin en code). Dépassement = kill = `agent_failure` reason=budget. **Le comptage vient du driver contract (ADR-004 v2) : chaque driver DOIT exposer son usage ; un driver qui ne le peut pas est inéligible au chemin critique.**
- **Plafond de dépense fleet/jour** : `FLEET_DAILY_SPEND_LIMIT` (défaut **15 €/jour**, en config — arbitré). **Gate à l'admission uniquement, jamais de kill mid-run pour cause de plafond fleet** (arbitré : pas d'arrêt brutal des agents) : les jobs en cours terminent, le puller se met en pause, les dispatches non-`urgent` sont refusés avec raison explicite, notification P0.
- **Un budget termine une tentative, jamais un work item** (arbitré) : l'épuisement (budget, timeout, stall) rend l'item **visible** — état terminal + diagnostic + retour au backlog. Rien n'est silencieusement abandonné : le PM re-découpe ou re-budgète, et l'item repart. Un item du backlog sera fait tôt ou tard — le budget protège contre les tentatives condamnées, pas contre le travail.

## 7. Annulation

- `cancel_job` (MCP/dashboard) → API → **canal de contrôle Redis pub/sub `worker:control`** → le worker SIGTERM le process, nettoie, instance `cancelled`. (Remplace le stub `agent-hub-client.js:71` ; le socket.io hub devient optionnel.)
- Le `POST /kill/:jobId` local reste comme fallback opérateur.
- Cancel est **toujours accepté** sur un job live ; sur un job déjà terminal, no-op idempotent.

## 8. Reprise après crash/restart du worker

Au boot, avant de consommer la queue, le worker exécute la **réconciliation** :
1. Jobs BullMQ `active` sans process vivant correspondant → `failed`, classe `infra_failure` reason=worker_restart. **Pas de re-run automatique** (l'état du worktree est inconnu).
2. Process orphelins matchant sa signature de spawn (claude -p / docker) → SIGKILL.
3. Worktrees sans job live → réclamés (le mécanisme `worktree.js` existe déjà).
4. Instances live violant l'invariant §3.2 → `failed` reason=stale_reconciled.
Idempotent ; loggé ; notifie un résumé s'il a réconcilié quoi que ce soit.

## 9. Idempotence du dispatch

Dispatcher un work item qui a déjà une instance **live** → refus avec l'`instance_id` existant (même pattern que `project_not_linked`). Re-dispatch autorisé seulement depuis un état terminal. Un `--force` explicite cancel-puis-redispatch.

## 10. Dispatch automatique

Le backlog-puller est **OFF par défaut** (`BACKLOG_PULL_MAX_PER_TICK=0`). Activation explicite par projet, et il respecte : vagues (ADR-001), plafond de dépense (§6), idempotence (§9). L'incident du 11/08 (spam de dispatches pendant une rotation de token) devient impossible par construction.

## 11. Conformité — le bench EST le contrat exécutable

**Le bench est une matrice : chaque scénario × {claude (référence), pi (plancher)}** — ADR-004 v2. « Moteur prêt » = **la colonne plancher passe**. Une colonne claude verte seule ne valide rien : elle mesure le masquage du moteur par le modèle. D5 (cancel) et D6 (réconciliation) sont driver-agnostiques et ne tournent qu'une fois.

| Scénario bench | Sections vérifiées |
|---|---|
| D1 item simple → PR verte sans intervention | §3, §4 chemin nominal |
| D2 chaîne de 3 items `blocked_by` → ordre respecté | ADR-001 |
| D3 item conçu pour échouer → classes §4.2, pas de boucle, notifications §4.3 | §4 |
| D4 dépassement timeout + budget → kill + rescue | §5, §6 |
| D5 cancel distant mid-run → stop propre | §7 |
| D6 kill -9 du worker mid-run → boot → réconciliation sans zombie ni double-dispatch | §8 |

La prod ne se rallume que si D1–D6 passent ; le bench tourne avant chaque relight.

---

## Arbitrages rendus (Franck, 2026-08-18)

1. ✅ `FLEET_DAILY_SPEND_LIMIT` = 15 €/jour en config — **gate à l'admission, jamais de kill brutal mid-run** (§6).
2. ✅ BullMQ `attempts: 1` + retries classifiés dans l'engine — « réessayer la même chose sans changement ne sert à rien ».
3. ✅ Les longs timeouts sont rejetés comme cadre : **petites tâches + itérations courtes + détection de stall à 5 min** ; le wall-clock devient un filet réduit (§5). L'incident « 1 h sans commit » est le cas d'école que le stall-detect élimine.
