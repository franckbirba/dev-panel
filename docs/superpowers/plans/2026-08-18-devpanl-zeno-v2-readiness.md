# Devpanl → Zeno V2 readiness — audit + plan v2 (architecture d'abord)

> **For agentic workers:** ceci est le plan-cadre (roadmap). Les chantiers de build (Phase C) reçoivent chacun leur plan d'implémentation détaillé (superpowers:writing-plans) au moment de l'exécution — APRÈS validation des ADRs de Phase A. Ne pas commencer le build sans les specs.
>
> **⚠️ La prod est coupée VOLONTAIREMENT.** `devpanel-worker` est inactive depuis le 11/08 par décision de Franck — le moteur n'est pas jugé capable de porter le travail sans babysitting. **Ne pas le redémarrer.** Le relight est gated sur le bench d'acceptation (Phase D).

**Goal:** rendre le moteur devpanl réellement capable de porter la refacto Zeno V2 (cycle « Phase 1 — Zeno V2 générique », 13 items ordonnés) — en travaillant d'abord l'architecture et la documentation, ensuite le code, et en ne rallumant la prod que sur bench vert.

**Architecture (du plan):** quatre temps — (A) écrire l'architecture qui n'a jamais été écrite (contrat du moteur, orchestration, contrats agents/repos, story drivers), (B) faire de la documentation le runtime qu'elle est censée être pour une fleet d'agents, (C) builder spec-driven les capacités manquantes, (D) prouver que « prêt » veut dire quelque chose avec un bench d'acceptation reproductible. Zeno V2 (E) ne démarre qu'après.

**Diagnostic partagé:** le moteur exécute *un* work item (PRs Zeno réellement mergées en mai — il n'est pas « capable de rien ») mais au prix d'un babysitting constant : misroutes, rescue commits, boucles reviewer, traps d'env non fixés, incidents documentés en mémoire plutôt qu'en spec. La cause racine n'est pas un bug, c'est que **l'orchestration, les contrats et la sémantique d'échec n'ont jamais été architecturés** — le moteur a grossi par accrétion de patches post-incident. Et la doc-runtime (CLAUDE.md, SOULs, env) est fausse par endroits, or pour des agents, la doc EST le code.

---

## Partie 1 — Audit (2026-08-18, main @ 3483cfc)

### État runtime constaté

| Composant | État | Preuve |
|---|---|---|
| `devpanel-worker` (agents host) | **OFF volontairement depuis le 11/08 20:39 UTC** (SIGTERM, workflow « Fleet Pause » — le backlog-puller spammait des dispatches pendant la rotation de token). Décision de Franck : reste OFF tant que le moteur n'est pas re-architecturé. | `systemctl status` : `inactive (dead)`, `signal=TERM` |
| Shelly (Claude) | active, telegram-multi vivant | `systemctl is-active shelly` ; `pgrep bun` |
| File BullMQ | gelée : 2 jobs « active » du 11/08, 7 échecs builder du 11/08, 3 crons repeat en failed | `list_jobs` |
| Workflow instances | zombies de mai (« running » 961/959, « awaiting_approval » 2088/2514/3763/3770) | `fleet_status` |
| `devpanel-api` | **crashe quand on appelle un tool MCP adossé à SSH** (`host_status`, `run_remote_check`) — reproduit 3× pendant l'audit | transport dropped ×6 ; container « Up 3 minutes » |
| Clone Zeno (agents host) | périmé (2026-05-10) ; pas de `.devpanel-worktrees/` dans `.gitignore` ; **remote avec token `ghp_…` en clair (leaké → à révoquer immédiatement, prod OFF n'y change rien)** | SSH direct |
| Captures inbox | ~30 « new » depuis avril, dont bugs prod Zeno de la direction (Bachelor→PGE ×2) | `list_captures` |
| Cycle « Phase 1 — Zeno V2 générique » | 13 items, 18–25/08, 0 démarré — à re-dater | `cycle_overview ZENO` |

### Findings

**P0 — sécurité/intégrité (indépendants du relight)**
- **F2. Tools MCP SSH crashent l'API prod** — exception/timeout SSH non contenue (`src/mcp/runtime.js`, `src/capabilities/run-remote-check.js`) tue le process Express.
- **F3. Token GitHub leaké** dans le remote du clone Zeno + clone périmé + `.gitignore` sans `.devpanel-worktrees/`.
- **F4. Zéro CI de tests ; 14/861 tests cassés sur main** — dont `webhooks-github-merged.test.js` (chemin merge-coordinator), `handleThreadAppend` non exporté (`src/mcp/server.js:1419`), `RENDERER_PAYLOAD_TYPES` 7 vs 8.

**P1 — les capacités que le moteur n'a pas (le « capable de rien »)**
- **F5. Zéro dépendance inter-items, zéro batch** — moteur YAML intra-item seulement ; dispatch 1 item/appel ; puller mono-projet.
- **F6. Pas de timeout wall-clock** — seul plafond : lock BullMQ 30 min → double-dispatch possible ; `activeProcesses` non réconcilié.
- **F7. Budget tokens : policy sur papier (SOUL Shelly), rien en code.**
- **F8. Cancel distant = stub** (`agent-hub-client.js:71` TODO).
- **F9. SOULs/skills toujours lus depuis dev-panel** (`prompt-builder.js:17,85`) — pas de conventions par repo cible.
- **F10. Container driver : 0 test + trap `NODE_ENV=production`** (lockfile drift) documenté le 11/08, non fixé. 4 drivers (claude/pi/goose/container) pour 1 seul réellement fiable.
- **F11. `devpanl:doctor` aveugle aux préconditions services-side** (row projects, local_path, clone, gitignore) — un doctor vert ne prouve rien.
- **F-ops. Sémantique d'échec émergente, pas spécifiée** — retries BullMQ ×3 + `max_revisions: 3` + replan + rescue PR interagissent sans contrat écrit ; les incidents de mai/août (misroutes, boucles, spam puller) sont documentés en *mémoires*, pas en *spec*.

**P2 — dette consciente (post-refacto)**
- **F12.** Dashboard chat = deuxième cerveau déconnecté (DEVPA-204 partiel), provider switcher décoratif, settings vide, fork sans UI, 2 backends chat dupliqués, DEVPA-180 violé par 6 tools.
- **F13.** Hygiène : `src/dashboard/` legacy 3 mois post-deadline ; CLAUDE.md faux (« npm test = no-op ») ; 88/112 env vars non documentées ; docs OpenClaw mortes ; deploy SOUL contredit le chemin CI.
- **F14.** Triage captures à l'arrêt depuis avril.

### Ce qui est SOLIDE (à conserver tel quel dans la re-architecture)
Worktree isolation per-repo (testée) · résolution cross-repo avec refus explicite · commit-authority + rescue PR · moteur YAML intra-item · permission gate dashboard · compaction · OAuth MCP fixé (#274) · zod 4 propre · 780/861 tests verts. **La re-architecture ne jette pas ça — elle écrit le contrat autour et ajoute l'étage d'orchestration qui manque.**

---

## Partie 2 — Le plan v2 : architecture → doc → build → bench → Zeno

### Phase S — Sécurité immédiate (aujourd'hui, ~1 h, indépendant de tout)

- [ ] **S1 (périmètre élargi le 2026-08-19).** Le token `ghp_…` du remote Zeno est en réalité **le token studio-wide de la table `projects`** : réutilisé pour chaque nouveau projet (constaté à la création de BENCH) et **sérialisé en clair par les réponses MCP** `studio_add_project`/`studio_list_projects` (deuxième fuite). Rotation complète : (1) révoquer le token chez GitHub, (2) générer un remplaçant (fine-grained, scope repos du studio) et le remplacer dans la table `projects`, (3) re-câbler les remotes des clones agents-host (Zeno, EDMS, dev-panel, bench) en deploy key SSH, (4) fixer la sérialisation MCP pour ne plus jamais retourner `github_token` (chip de tâche déjà créée).
- [ ] **S2.** Fixer le crash MCP SSH (F2) — l'API sert encore le dashboard/captures même prod-fleet OFF ; un tool qui tue le container reste un bug prod. Petit chantier : try/catch + timeout + erreur JSON-RPC propre + test vitest.
- [ ] **S3.** Purge cosmétique de la file et des workflow_instances zombies (pour que `fleet_status` redevienne un instrument fiable pendant le chantier).

### Phase A — Architecture : écrire ce qui n'a jamais été écrit (2–3 j, l'essentiel du travail)

Livrables : des ADRs courts + une spec, dans `docs/architecture/`. Chacun validé par Franck avant build. C'est le cœur de la réponse à « nous n'avons pas assez travaillé l'architecture ».

- [ ] **A1. `engine-contract.md` — la spec du moteur.** Le document qui n'existe pas et dont l'absence explique tous les incidents : cycle de vie d'un job (états, transitions, qui a autorité) ; sémantique d'échec UNIFIÉE (retries BullMQ × revisions × replan × rescue — qui prime, quand on abandonne, ce que voit Franck) ; timeout par rôle ; budget tokens par rôle ; cancel (local + distant) ; reprise après crash/restart du worker (réconciliation process/worktrees/instances) ; idempotence du dispatch.
- [ ] **A2. `adr-orchestration-multi-items.md`.** Waves + `blocked_by` Plane, topo-sort, re-tick au merge (webhook existant), rollup. Explicitement PAS un DAG engine. Inclut la définition de « agent-ready » (template work item : contexte, AC, fichiers, dépendances) — les mémoires montrent que 100 % des items vagues finissent blocked.
- [ ] **A3. `adr-contrats-agents.md`.** Job output contract (existant, à canoniser) ; SOUL layering studio → repo cible → rôle (résout F9 proprement) ; ce qu'un agent a le droit de faire par rôle (traduit les SOULs en contraintes vérifiables).
- [ ] **A4. `adr-onboarding-repo.md`.** Le contrat machine-vérifiable qu'un repo cible doit remplir (row projects + local_path + clone frais + `.gitignore` + souls + commandes test/build déclarées dans `.devpanlrc.json`) — ce que `doctor` devra vérifier via l'admin API (résout F11).
- [ ] **A5bis. `adr-005-harness.md` (requirement Franck 2026-08-18 : « c'est ça notre problème »).** Le harness contract H1–H9 (boucle d'outils, édits robustes, sortie structurée forcée, auto-approve sandboxé, contexte, usage exposé, MCP, env honnête, boucle interne outillée) + build-vs-adopt : O1 pi+extensions d'abord, O2 harness maison si les gaps H2/H3 sont structurels — verdict par le bench plancher, pas au feeling.
- [ ] **A5ter. `adr-006-graphe-et-boucles.md` (requirement Franck 2026-08-18 : « we need graph, and looping system »).** Le workflow YAML devient un graphe explicite ; les boucles sont déclarées (`until` + `max_iterations` + budget par boucle) — cycle non déclaré = YAML rejeté au chargement ; deux niveaux de boucle (interne harness H9 / externe engine) ; prédicats mécanisables vérifiés par le worker (`tests_green` = il exécute `commands.test` lui-même). Bench : + scénario D7 (convergence et non-convergence).
- [ ] **A5. `adr-drivers.md` (v2 — requirement Franck 2026-08-18).** Moteur **model-agnostic par contrat** : driver contract formel (spawn, usage, kill, enveloppe) ; **claude = référence, pi/Qwen = plancher** au chemin critique ; multi-tier par rôle en stratégie nominale ; goose/mini-swe en quarantaine ; le harness (édits robustes, auto-approve sandboxé, usage exposé) devient un chantier nommé. Claude-only est explicitement rejeté : un modèle trop capable masque les faiblesses du moteur.

### Phase B — Documentation = runtime (1–2 j, en parallèle de A)

Pour une fleet d'agents, la doc n'est pas un à-côté : SOULs, CLAUDE.md et skills sont le code que les agents exécutent. Aujourd'hui elle ment par endroits.

- [ ] **B1.** CLAUDE.md véridique (npm test réel, chemins morts retirés, section moteur alignée sur A1).
- [ ] **B2.** Env vars : documenter les ~15 qui gatent le comportement (DRIVER_*, FORCE_TIER, ENABLE_MCP_HTTP, BACKLOG_PULL_*, TRUST_FORWARDED_USER, API_BASE, ADMIN_API_KEY…) dans `.env.example` + un `docs/architecture/env.md`.
- [ ] **B3.** Runbooks : start/stop/pause de la fleet (le « pourquoi c'est OFF » du 11/08 n'était écrit nulle part), incident, rotation de secrets.
- [ ] **B4.** Purge des docs mortes (docs/SHELLY.md OpenClaw, skills/README stale, .claude/commands/devops.md Makefile) + `.agents/deploy/SOUL.md` aligné sur le deploy CI réel.
- [ ] **B5.** Re-générer les SOULs depuis les ADRs A3 (et le gabarit de souls du plugin devpanl mis à jour pour les futurs repos).

### Phase C — Build spec-driven (3–5 j, chaque chantier = son plan writing-plans)

Les chantiers de l'audit, re-scopés par les specs de A :

- [ ] **C1.** CI test gate (`vitest run` dans pr-checks.yml) + réparer les 14 tests cassés — préalable à tout le reste.
- [ ] **C2.** Sémantique d'échec + timeout + budget + cancel + réconciliation au boot — implémentation de A1.
- [ ] **C3.** SOUL layering per-repo dans prompt-builder — implémentation de A3.
- [ ] **C4.** `dispatch_wave` + respect `blocked_by` + rollup — implémentation de A2.
- [ ] **C5.** Endpoint admin `readiness` + doctor services-aware — implémentation de A4.
- [ ] **C6.** Backlog-puller : OFF par défaut (`BACKLOG_PULL_MAX_PER_TICK=0`), réactivation explicite par projet — plus jamais de dispatch non demandé.
- [ ] **C7.** Audit pi contre H1–H9 + comblement des gaps par extensions — implémentation de l'ADR-005, **O1 tranché par Franck le 2026-08-18 (« on investit sur pi »)**. Priorités d'audit : H2 (stress-test des édits builtin), H4 (auto-approve sandboxé — la cause du 11/08), H6 (usage exposé — bloquant pour le budget §6). Base : 7 extensions vendored ~2 400 LOC + pi-driver `--mode json`.
- [ ] **C8.** Moteur de graphe + boucles déclarées + validateur (cycle non déclaré = rejet) + migration des 4 YAMLs + boucle interne H9 — implémentation de l'ADR-006. Le plus lourd de la phase ; séquençable après C1–C6.

### Phase D — Bench d'acceptation : la définition de « prêt » (1 j)

Un repo sandbox dédié (clone jetable, items Plane de test) + un script `scripts/bench-engine.sh` qui déroule et vérifie :

- [ ] **D1.** Item simple → PR verte bout-en-bout sans intervention.
- [ ] **D2.** Chaîne de 3 items `blocked_by` → exécution dans l'ordre via `dispatch_wave`.
- [ ] **D3.** Item conçu pour échouer → sémantique d'échec conforme à A1 (pas de boucle, rescue propre, notification claire).
- [ ] **D4.** Job qui dépasse timeout/budget → tué + rescué.
- [ ] **D5.** Cancel distant pendant un run → stop propre.
- [ ] **D6.** Kill -9 du worker mid-run → restart → réconciliation sans zombie ni double-dispatch.
- [ ] **D7.** Convergence de boucle (ADR-006) : un item exigeant 2 itérations converge par `until` ; un item non-convergent est arrêté par bornes + budget, termine `exhausted`, notifie.

**Le bench est une matrice D1–D6 × {claude référence, pi plancher} (ADR-004 v2). La prod ne se rallume que quand la colonne plancher passe** — une colonne claude verte seule mesure le masquage du moteur par le modèle, pas la readiness. Le bench reste ensuite comme test de non-régression avant chaque relight. (D5/D6 driver-agnostiques : une exécution.)

### Phase E — Zeno V2 (dès bench vert, cycle re-daté ~1er septembre)

Inchangé sur le fond :
- [ ] Poser les relations `blocked_by` dans Plane sur les 13 items (faisable dès maintenant, ops 30 min).
- [ ] Ordre : **829** (sécu, canary réel) → **830 kernel (architect-pass + review humaine, rien ne part avant son merge)** → **831** → **832 ∥ 833** → **834 ∥ 835/836 (gate humaine sur 835)** → **837/838 ∥ 839** → **840**.
- [ ] `max_parallel=2` au début ; architect-pass avant builder sur chaque [REFACTO] ; triage des captures Zeno en parallèle (Bachelor→PGE attend depuis juin).
- [ ] Pilotage : Shelly/Telegram + Plane + bull-board. Le dashboard reste en lecture ; DEVPA-204 et le reste de F12 = dette consciente post-refacto.

### Dette consciente (inchangée)
Bridge Shelly↔dashboard complet, fusion des 2 backends chat, suppression `src/dashboard/`, container driver par défaut, PR #271, vieilles PRs (#265, #206, #92), cartes UI manquantes.

### Estimation (révisée après ADR-005/006 + arbitrage seuil du 2026-08-19)
S ~1 h · A 2–3 j · B 1–2 j (parallèle) · C 5–8 j (C1–C6 : 3–5 j ; C7 harness : 1–2 j ; C8 graphe/boucles : 2–3 j) · D 1–2 j (matrice ×2 drivers + D7) · **~3 semaines pour le moteur complet**. **Le go Zeno exige le bench COMPLET D1–D7 colonne plancher verte** (arbitrage Franck : « devpanl doit permettre de dev de vraies applis complexes et lourdes » — pas de go partiel). Cible réaliste du premier dispatch Zeno : **~semaine du 8 septembre**. Les seuls leviers d'accélération légitimes : paralléliser C7/C8 avec C1–C6 (plans séparés, agents séparés) et pré-écrire le bench (D) pendant la phase A.
