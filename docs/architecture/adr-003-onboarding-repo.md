# ADR-003 — Onboarding repo : un contrat machine-vérifiable, vérifié des deux côtés

**Statut : DRAFT — à valider.** Réfs : audit 2026-08-18 F3, F11 ; mémoire `infra_cross_repo_routing`.

## Contexte

Le dispatch cross-repo exige des préconditions réparties sur trois systèmes : le repo cible (souls, `.gitignore`, config), la table `projects` côté services (plane_project_id, local_path), et le filesystem de l'agents host (clone existant, frais, authentifié). Aujourd'hui `devpanl:doctor` ne vérifie que le premier tiers — **un doctor vert sur Zeno ne prouve pas que Zeno est dispatch-ready** (constaté : clone périmé de 3 mois, `.gitignore` sans `.devpanel-worktrees/`, token `ghp_` en clair dans le remote). Les misroutes de mai (EDMS/ZENO clonés dans dev-panel) sont la version catastrophique du même trou.

## Décision

### 1. Le contrat repo-ready, énuméré

**Côté repo cible (versionné avec le code) :**
- R1. `.devpanlrc.json` : `plane.project_id`, `default_branch`, et **les commandes déclarées** `commands.test`, `commands.build`, `commands.lint` (finies les suppositions type « npm test est un no-op »).
- R2. `.agents/<role>/SOUL.md` overlays L2 (ADR-002 §2) pour au minimum builder, reviewer, qa.
- R3. `.gitignore` contient `.devpanel-worktrees/`.
- R4. Section « DevPanel integration » dans le CLAUDE.md du repo.
- R5. Une CI qui exécute `commands.test` sur PR (le merge-coordinator gate dessus).

**Côté services (table `projects`) :**
- S1. Row existante, `plane_project_id` non nul et **cohérent avec R1** (les deux valeurs sont aujourd'hui indépendantes — personne ne les cross-checke).
- S2. `local_path` non nul.
- S3. `github_owner/github_repo` posés, `default_branch` cohérent avec R1.

**Côté agents host :**
- A1. Clone existant à `local_path`.
- A2. **Frais** : dernier `git fetch` < 48 h (sinon warning) ; le worker fetch de toute façon au `prepareWorktree`.
- A3. **Auth propre** : remote SSH deploy-key ou credential helper — **jamais de token dans l'URL du remote** (check bloquant : c'est le leak constaté sur Zeno).

### 2. Un endpoint readiness, deux consommateurs

`GET /api/admin/projects/:id/readiness` (admin-key) exécute S1–S3 localement et A1–A3 via le canal worker (le worker expose un check local — pas de SSH depuis l'API, cf. le crash F2). Réponse : `{ ready: bool, checks: [{id, status: pass|warn|fail, detail}] }`.

- **`devpanl:doctor`** l'appelle quand `API_BASE` + `ADMIN_API_KEY` sont présents et affiche les checks à côté des siens (R1–R5). Sans creds : il le dit explicitement (« côté services non vérifié ») au lieu d'afficher un vert mensonger.
- **`enqueueWorkflowStart`** consulte le readiness (caché 10 min) et **refuse** un dispatch vers un projet `fail` — la précondition cesse d'être une note de mémoire pour devenir une garde.

### 3. L'onboarding devient un flow, pas une checklist orale

`studio_add_project` (existant) enchaîne déjà row + clone bootstrap. On y ajoute : pose de R3 par PR automatique proposée (jamais silencieuse), génération des L2 via `devpanl:init`, et un readiness final affiché. Un projet n'est annoncé « prêt » que readiness vert.

## Conséquences

- (+) « Est-ce que Zeno est prêt ? » devient une commande, pas une enquête.
- (+) La classe misroute/precondition (3 incidents documentés) devient impossible au dispatch, pas seulement diagnosticable après.
- (−) Le check A* transite par le worker → le readiness complet exige un worker démarré ; en son absence l'endpoint rend `warn` explicite (« agents host non vérifiable »), pas un faux vert. Acceptable : sans worker, on ne dispatche pas de toute façon.
- (−) R5 (CI sur le repo cible) est un prérequis humain — Zeno l'a déjà, EDMS à vérifier.

## Alternatives rejetées

- **Doctor local-only** (statu quo) : c'est F11.
- **Auto-fix silencieux par le worker** (ajouter le `.gitignore`, refetch, réécrire le remote) : le worker ne mutera jamais la config d'un repo cible sans PR — même famille d'interdits que le commit-authority.
- **SSH depuis l'API pour les checks A\*** : c'est l'architecture qui crashe l'API aujourd'hui (F2) ; le worker est déjà sur place.
