# Architecture devpanl — cible v2

**Statut : DRAFT — accompagne `engine-contract.md` (v1.1) + ADR-001→004 (ADR-004 v2).** Chaque flèche de ces schémas est gouvernée par une section de contrat (table des frontières en bas). Le moteur est **model-agnostic par contrat** : deux drivers au chemin critique — claude (référence) et pi/Qwen (plancher) — et le bench se lit en matrice, « moteur prêt » = colonne plancher verte. Ce qui n'apparaît pas ici (dashboard bridge DEVPA-204, container driver, goose/mini-swe) est hors chemin critique par décision, pas par oubli.

---

## Vue 1 — Conteneurs et frontières

```mermaid
flowchart TB
  FR(["Franck + devs"])

  subgraph SURF["Surfaces"]
    TG["Telegram"]
    DASH["Dashboard chat — lecture + cards"]
    CLI["Claude Code / clients MCP"]
  end

  subgraph SVC["Services VPS — 10.0.0.2"]
    API["devpanel-api — REST, MCP HTTP, webhooks, readiness"]
    PG[("Postgres — instances, waves, threads, memories pgvector")]
    RD[("Redis — BullMQ devpanel-agents + pub/sub worker:control")]
    PLANE["Plane — work items, relations blocked_by, cycles"]
  end

  subgraph AG["Agents host — 10.0.0.3"]
    SH["Shelly — session Claude persistante + telegram-multi"]
    WK["devpanel-worker — engine YAML, gates, drivers: claude référence + pi plancher"]
    CL["clones projets + .devpanel-worktrees par job"]
  end

  GH["GitHub — PRs, CI, webhooks"]
  AN["APIs modèles — Anthropic, DeepInfra (Qwen, DeepSeek)"]

  FR --> TG
  FR --> DASH
  FR --> CLI
  TG <-->|"getUpdates / sendMessage — 1 poller par token"| SH
  DASH -->|"REST + SSE"| API
  CLI -->|"MCP HTTP — Bearer"| API
  SH -->|"tools MCP"| API
  API -->|"REST"| PLANE
  API --> PG
  API -->|"enqueue jobs, publie cancel"| RD
  WK -->|"consomme jobs, écoute worker:control"| RD
  WK -->|"états instances — SEUL écrivain"| PG
  WK -->|"1 worktree par job"| CL
  WK -->|"spawn via driver contract — timeout, budget, usage"| AN
  WK -->|"push + PR — commit authority"| GH
  WK -->|"notifyJob — terminaux et blocked"| TG
  GH -->|"webhook PR — merge-coordinator + re-tick vague"| API
```

Trois invariants portés par cette vue : **le worker est le seul écrivain** des états (API et Shelly demandent, n'écrivent pas) ; **un seul poller Telegram par token** (Shelly) ; **l'API ne fait jamais de SSH** — les checks agents-host passent par le canal worker (le crash F2 de l'audit est une violation de cet invariant).

## Vue 2 — Cycle de vie d'un work item dans une vague

```mermaid
sequenceDiagram
  autonumber
  actor F as Franck / PM
  participant S as Shelly
  participant A as devpanel-api
  participant Q as BullMQ
  participant W as worker
  participant B as builder claude
  participant G as GitHub

  F->>S: dispatch_wave cycle, max_parallel 2
  S->>A: MCP dispatch_wave
  A->>A: gates — readiness ADR-003, blocked_by ADR-001, idempotence §9, template agent-ready
  A->>Q: enqueue vague 1 — attempts=1
  Q->>W: job builder
  W->>W: worktree repo/.devpanel-worktrees/jobId
  W->>B: prompt L1 studio + L2 repo cible + L3 item — ADR-002
  B-->>W: enveloppe v1 — status, artifacts, handoff
  W->>W: classification §4.2 puis verifyAndCommit
  W->>G: push + PR
  Note over Q,G: reviewer puis qa — YAML work-item, max_revisions 3
  G->>A: webhook PR merged
  A->>Q: re-tick vague — dispatch des items débloqués
  W--)F: notifyJob — états terminaux et blocked uniquement
```

Le re-tick est **événementiel** (webhook merge existant), jamais du polling. La vague avance au **merge** du blocker, pas au QA-done — pour un refacto, c'est l'état du repo qui fait foi (ADR-001, question ouverte n°2).

## Vue 3 — Taxonomie d'échec (remplace retries BullMQ × revisions × replan × rescue empilés)

```mermaid
flowchart TB
  X["échec pendant un job"] --> C{"classification — contrat §4.2"}
  C -->|"avant tout travail — clone, auth, spawn"| I["infra_failure"]
  C -->|"pendant ou après — enveloppe invalide, timeout, budget, crash"| A["agent_failure"]
  C -->|"enveloppe failed — reviewer ou qa"| Q["quality_failure"]
  C -->|"enveloppe blocked"| M["ambiguity"]

  I -->|"retry engine, max 2, backoff"| RE["re-exécution"]
  I -->|"retries épuisés"| F1["failed — infra"]
  A -->|"diff non vide"| R["rescue PR needs-review"]
  R --> F2["failed — agent"]
  A -->|"diff vide"| F2
  Q -->|"revision loop YAML, max 3"| RE
  Q -->|"exhaustion"| E["exhausted"]
  M --> P["replan par le PM"] --> W2["awaiting_input — humain"]

  F1 --> N["notification — classe, raison, action possible"]
  F2 --> N
  E --> N
  W2 --> N
```

Règle unique : **une classe = un mécanisme = une borne.** BullMQ passe à `attempts: 1` — c'est l'engine qui décide des retries parce que lui seul sait classifier. Un `agent_failure` n'est **jamais** re-exécuté automatiquement (le 11/08 : 18 exécutions payantes pour 3 items, zéro merge).

## Vue 4 — Machine à états d'une instance

```mermaid
stateDiagram-v2
  [*] --> running: dispatch — gates passées
  running --> awaiting_approval: étape gated humaine
  awaiting_approval --> running: approve
  running --> awaiting_input: ambiguity après replan
  awaiting_input --> running: réponse humaine
  running --> completed: dernier step done
  running --> failed: infra épuisée ou agent_failure
  running --> exhausted: max_revisions atteint
  running --> cancelled: cancel via worker:control
  completed --> [*]
  failed --> [*]
  exhausted --> [*]
  cancelled --> [*]
```

Invariant anti-zombie (§3.2 + §8) : tout état live exige un job BullMQ vivant **et** un `last_event_at` frais ; sinon la réconciliation au boot le passe en `failed — stale_reconciled`. `cancel` est accepté depuis n'importe quel état live (y compris `awaiting_*`). Re-dispatch autorisé **uniquement** depuis un état terminal (§9) — les rows « running » de mai encore visibles en août sont exactement ce que ces deux règles interdisent.

## Vue 5 — Cycle de vie d'une vague (ADR-001)

```mermaid
stateDiagram-v2
  [*] --> planned: topo-sort des relations Plane — cycle détecté = refus
  planned --> running_wave: dispatch premier front — max_parallel
  running_wave --> running_wave: merge d'un blocker — arme les dépendants
  running_wave --> done: tous les items completed
  running_wave --> partial: un item failed — dépendants gelés, le reste continue
  partial --> running_wave: re-dispatch après correction
  done --> [*]
```

## Vue 6 — Modèle d'exécution intra-item : graphe explicite, boucles bornées (ADR-006)

```mermaid
flowchart LR
  subgraph LOOP["loop revision — until review.done · max_iterations 3 · budget 400k"]
    B["build — builder"]
    R["review — reviewer"]
  end
  B -->|"boucle interne H9"| B
  B -->|done| R
  R -->|"failed — rejet"| B
  R -->|done| Q["qa"]
  Q -->|done| T(["terminal"])
  B -.->|blocked| P["replan — PM"]
  R -.->|blocked| P
  Q -.->|"failed ou blocked"| P
```

Deux niveaux de boucle : **interne** (harness H9 — le builder itère test→fix dans sa session, le moins cher, décisif pour le modèle plancher) et **externe** (engine — cycle entre agents, nommé, avec `until` + `max_iterations` + budget PAR boucle). Règle de validation au chargement : **tout cycle du graphe doit appartenir à une boucle déclarée, sinon le YAML est rejeté** — la terminaison redevient démontrable. Les prédicats mécanisables sont vérifiés par le worker lui-même (`tests_green` = il exécute `commands.test`), pas déclarés par l'agent — même philosophie que le commit-authority.

## Table des frontières — quelle flèche, quel contrat

| Frontière | Gouvernée par |
|---|---|
| Gates au dispatch (readiness, blocked_by, idempotence, agent-ready) | ADR-003 · ADR-001 · contrat §9 |
| Composition du prompt (L1/L2/L3) | ADR-002 §2 |
| Enveloppe de sortie agent | ADR-002 §1 · contrat §3.1 |
| Classification, retries, rescue | contrat §4 |
| Timeout / budget du spawn | contrat §5 · §6 |
| Cancel (`worker:control`) | contrat §7 |
| Réconciliation au boot | contrat §8 |
| Commit / push / PR (autorité) | ADR-002 §3 — worker only |
| Exécution d'un job (boucle d'outils, édits, permissions, usage) | ADR-005 — harness contract H1–H9 |
| Modèle d'exécution intra-item (graphe, boucles, prédicats) | ADR-006 — cycle non déclaré = rejet au chargement |
| Choix du driver | ADR-004 v2 — driver contract ; claude référence + pi plancher, multi-tier par rôle |
| Dispatch automatique (puller) | contrat §10 — OFF par défaut |
| Conformité globale | bench D1–D6 × {claude, pi} = contrat §11 — « prêt » = colonne plancher verte |
