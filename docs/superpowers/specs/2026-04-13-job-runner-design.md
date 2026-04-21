# Job Runner BullMQ — Design Spec

## Objectif

Transformer DevPanel en centre de contrôle d'une équipe d'agents autonomes H24. Un worker BullMQ sur le serveur agents consomme les jobs et spawne des agents éphémères `claude -p`. Shelly orchestre via le MCP DevPanel. Franck supervise depuis le dashboard et Telegram.

## Contexte

### Ce qui existe

- **BullMQ core** (`src/server/bullmq.js`) — queues, workers, DLQ, health, retry
- **API REST** (`src/server/routes.js`) — gestion queues/jobs (pause, resume, retry, clean, promote, remove)
- **MCP server stdio** (`src/mcp/server.js`) — 7 tools (projets, tickets, docs, messages)
- **Dashboard React** (`src/dashboard/`) — Queue Monitor avec JobList, JobDetail, actions admin
- **Skills agents** (`.claude/skills/`) — builder, designer, pm, reviewer
- **Redis** en prod sur serveur services (77.42.46.87), docker, `noeviction`
- **Alertes Telegram** (`src/server/alerts.js`) — batching, dédup, severity levels
- **SSE** (`src/server/sse.js`) — broadcast temps réel vers le dashboard

### Ce qui manque

1. Worker process qui consomme BullMQ et spawne `claude -p`
2. Tools MCP pour enqueue/list/cancel jobs
3. Endpoint POST pour enqueue depuis dashboard
4. SOUL files agents (`.agents/*/SOUL.md`)
5. Redis exposé sur IP privée du serveur services
6. Service systemd pour le worker
7. Mode autonome/collaboratif pour Shelly
8. Pipeline de validation (builder → reviewer → merge)
9. Crons automatiques (daily sync, sprint plan)
10. Morning review structuré
11. Kill job actif depuis dashboard

## Architecture

### Infrastructure

```
┌─────────────────────────────────────┐
│       Serveur Services              │
│       (77.42.46.87)                 │
│                                     │
│  API DevPanel (:3030)               │
│    ├── POST /api/jobs → enqueue     │
│    ├── GET/DELETE jobs → control     │
│    ├── POST /api/jobs/:id/kill      │
│    └── SSE → live status            │
│                                     │
│  Redis (:6379 sur IP privée) ◀──┐   │
│    └── Queue: agents            │   │
└─────────────────────────────────│───┘
                                  │
┌─────────────────────────────────│───┐
│       Serveur Agents            │   │
│       (62.238.0.167)            │   │
│                                 │   │
│  Worker (systemd) ──────────────┘   │
│    ├── concurrency: 3               │
│    ├── Spawne claude -p par job     │
│    ├── HTTP :3099 (kill/health)     │
│    └── Track PID des process actifs │
│                                     │
│  Shelly (tmux, Telegram)            │
│    └── MCP devpanel → enqueue_job   │
│                                     │
│  cwd: /home/deploy/projects/dev-panel│
└─────────────────────────────────────┘
```

### Queue unique avec priorités

Une seule queue `agents`. La priorité BullMQ trie l'ordre de dépilement.

| Priorité | Valeur BullMQ | Usage |
|----------|---------------|-------|
| P0 | 1 | Urgent — debug, hotfix, Franck demande maintenant |
| P1 | 5 | Haute — feature sprint en cours |
| P2 | 10 | Normal — roadmap, tâches planifiées |
| P3 | 20 | Basse — tech debt, docs, crons |

Concurrency 3 = max 3 `claude -p` en parallèle. Un builder code, un reviewer review, un PM qualifie — en même temps.

### Format d'un job

```javascript
{
  name: "build:DEVPA-42",
  data: {
    agent: "builder",
    task: {
      id: "DEVPA-42",
      title: "Créer composant Button",
      description: "...",
      branch: "feat/button-component"
    },
    skills: ["write-component", "stack-conventions"],
    priority: "p1",
    requested_by: "shelly",
    plane_issue_id: "uuid-xxx",
    source: "telegram"
  },
  opts: {
    priority: 5,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    timeout: 1800000  // 30min max
  }
}
```

### Cycle de vie d'un job

```
enqueue (Shelly / Dashboard / Cron)
    │
    ▼
 WAITING ─── priorité trie l'ordre
    │
    ▼
 ACTIVE ──── Worker dépile
    │   1. Lit .agents/{agent}/SOUL.md
    │   2. Lit .claude/skills/{skill}.md pour chaque skill
    │   3. Assemble le prompt (SOUL + skills + tâche)
    │   4. Spawne: claude -p "{prompt}" --print --dangerously-skip-permissions
    │   5. Update Plane → "in_progress"
    │   6. Notifie Telegram "job démarré"
    │
    ├── succès
    │     ▼
    │  COMPLETED
    │     ├── Update Plane → "done"
    │     ├── Résultat stocké dans returnvalue
    │     ├── Notifie Telegram "job terminé + résumé"
    │     └── Si pipeline: trigger job suivant (review → merge)
    │
    └── échec
          ▼
       FAILED → retry (max 3, backoff exponentiel)
          │
          ├── retry réussit → COMPLETED
          │
          └── 3 échecs → DEAD LETTER
                ├── Alerte Telegram "job échoué, intervention requise"
                ├── Mode collaboratif: attend Franck
                └── Mode autonome: note pour morning review, passe à la suite
```

## Worker Process

### `src/worker/index.js`

Process Node.js standalone lancé par systemd sur le serveur agents.

**Responsabilités :**
- Se connecte à Redis distant (77.42.46.87:6379)
- Consomme la queue `agents` avec concurrency 3
- Pour chaque job : lit SOUL + skills, assemble prompt, spawne `claude -p`
- Track les PID des process actifs (Map jobId → ChildProcess)
- Enregistre les repeatable jobs (crons) au démarrage
- Expose un HTTP local :3099 pour kill/health

### `src/worker/api.js`

Serveur HTTP minimal sur le serveur agents.

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/health` | GET | Statut du worker (uptime, jobs actifs, mémoire) |
| `/active` | GET | Liste des jobs actifs avec PID |
| `/kill/:jobId` | POST | Kill SIGTERM le process claude -p |

### `src/worker/prompt-builder.js`

Assemble le prompt pour `claude -p` à partir du SOUL et des skills.

```
[SOUL de l'agent]

## Skills
[Contenu de chaque skill demandé]

## Tâche
ID: DEVPA-42
Titre: Créer composant Button
Description: ...
Branche: feat/button-component

## Règles
- Travaille dans /home/deploy/projects/dev-panel
- Commit sur la branche indiquée
- Ne jamais git add -A (fichiers explicites uniquement)
- Quand tu as fini, résume ce que tu as fait en JSON:
  { "files_created": [...], "files_modified": [...], "tests_passed": bool, "summary": "..." }
```

### Systemd service

`infra/devpanel-worker.service` — auto-restart, user deploy, env vars pour Redis et Telegram.

## MCP DevPanel — Nouveaux Tools

Ajoutés dans `src/mcp/server.js`. Le MCP se connecte à Redis pour enqueue directement.

### `enqueue_job`

Enqueue un job dans la queue `agents`.

**Params :** agent (enum), task_id, task_title, task_description, skills (array), priority (p0-p3), branch (optionnel), source.

**Retour :** job ID BullMQ.

### `list_jobs`

Liste les jobs par statut (waiting, active, completed, failed, delayed).

**Params :** status, limit.

### `cancel_job`

Annule un job en attente (remove) ou kill un job actif (forward vers worker :3099).

**Params :** job_id.

## API REST — Nouveaux Endpoints

Ajoutés dans `src/server/routes.js`.

| Endpoint | Méthode | Auth | Description |
|----------|---------|------|-------------|
| `/api/jobs` | POST | API key | Enqueue un job (depuis dashboard) |
| `/api/jobs/:id/kill` | POST | Admin | Kill un job actif (proxie vers worker :3099) |

## SOUL Files Agents

### `.agents/builder/SOUL.md`

Tu es le Builder. Tu codes des features, fixes des bugs, écris des tests. Tu travailles toujours sur une branche dédiée. Tu commites avec des messages clairs. Tu ne merges jamais toi-même — le Reviewer s'en charge.

### `.agents/reviewer/SOUL.md`

Tu es le Reviewer. Tu reçois une branche du Builder. Tu vérifies : code quality, tests passent, pas de régression, conventions respectées. Si OK → tu approuves. Si KO → tu retournes avec les corrections demandées.

### `.agents/pm/SOUL.md`

Tu es le PM. Tu qualifies les tickets, écris les specs, priorise le backlog. Tu synchronises Plane, GitHub et DevPanel. Tu planifies les sprints.

### `.agents/designer/SOUL.md`

Tu es le Designer. Tu travailles dans Penpot. Tu génères des wireframes, des design tokens, des specs composants. Tu exportes les tokens pour le Builder.

### `.agents/architect/SOUL.md`

Tu es l'Architect. Tu écris les ADR (Architecture Decision Records). Tu reviews l'architecture avant les features complexes. Tu maintiens la cohérence technique.

### `.agents/qa/SOUL.md`

Tu es le QA. Tu valides après chaque PR mergée. Tu exécutes les tests, vérifies le build, checks les edge cases. Tu reportes dans Plane.

## Mode Autonome / Collaboratif

### Implémentation

Le mode est stocké dans un fichier d'état sur le serveur agents : `/home/deploy/.shelly-mode.json`

```json
{
  "mode": "autonomous",
  "since": "2026-04-13T23:00:00Z",
  "morning_review": []
}
```

Shelly lit ce fichier avant chaque décision. Le MCP DevPanel expose deux tools supplémentaires :

### `set_mode`

**Params :** mode (autonomous | collaborative)

Quand Franck dit "je vais dormir" → Shelly appelle `set_mode("autonomous")`.
Quand Franck dit "je suis là" → Shelly appelle `set_mode("collaborative")`.

### `get_mode`

Retourne le mode actuel. Le worker le consulte pour adapter son comportement :

**Mode autonome :**
- Builder → Reviewer auto → tests → merge si OK
- Échecs → note dans morning_review, passe à la suite
- Notifications Telegram en continu mais n'attend pas de réponse

**Mode collaboratif :**
- Builder → Reviewer → attend validation Franck avant merge
- Échecs → alerte Telegram et attend intervention
- Franck peut reprioriser à tout moment

## Pipeline de Validation

### builder → reviewer → merge

Quand un job builder se termine avec succès, le worker enqueue automatiquement un job reviewer :

```javascript
worker.on('completed', async (job, result) => {
  if (job.data.agent === 'builder' && result.tests_passed) {
    await agentsQueue.add('review:' + job.data.task.id, {
      agent: 'reviewer',
      task: {
        ...job.data.task,
        builder_output: result
      },
      skills: ['agent-reviewer'],
      source: 'pipeline'
    }, { priority: 5 });
  }
});
```

Le reviewer, s'il valide en mode autonome, fait le merge. En mode collaboratif, il notifie Shelly qui demande à Franck.

## Crons — Repeatable Jobs

Enregistrés au démarrage du worker.

| Job | Cron | Agent | Skills | Priorité |
|-----|------|-------|--------|----------|
| `pm:daily-sync` | `0 7 * * *` | pm | shelly-sync | P2 |
| `pm:sprint-plan` | `0 8 * * 1` | pm | agent-pm | P2 |
| `review:auto` | `0 */2 * * *` | reviewer | agent-reviewer | P3 |
| `health:check` | `*/30 * * * *` | — | stack-status | P3 |

## Morning Review

Quand Franck dit "je suis là", Shelly :

1. Lit le fichier `/home/deploy/.shelly-mode.json` → `morning_review[]`
2. Compile un résumé structuré :
   - Jobs complétés cette nuit (avec liens branches/PRs)
   - Jobs échoués (avec raison et stacktrace résumé)
   - Décisions en attente
   - État du backlog Plane
3. Envoie le résumé sur Telegram
4. Passe en mode collaboratif
5. Attend les instructions de Franck pour la journée

## Redis — Exposition

Dans `docker-compose.yml` (serveur services), ajouter le binding sur l'IP privée :

```yaml
devpanel-redis:
  ports:
    - "77.42.46.87:6379:6379"
```

Exposé uniquement sur l'IP du serveur (réseau Hetzner), pas sur 0.0.0.0. Note : 77.42.46.87 est l'IP publique mais les deux serveurs Hetzner se voient directement — pas besoin de VPN.

## Fichiers à créer/modifier

| Action | Fichier | Description |
|--------|---------|-------------|
| CREATE | `src/worker/index.js` | Worker process principal |
| CREATE | `src/worker/api.js` | HTTP local kill/health |
| CREATE | `src/worker/prompt-builder.js` | Assemblage prompt SOUL + skills + tâche |
| CREATE | `infra/devpanel-worker.service` | Systemd unit |
| CREATE | `.agents/builder/SOUL.md` | SOUL builder |
| CREATE | `.agents/reviewer/SOUL.md` | SOUL reviewer |
| CREATE | `.agents/pm/SOUL.md` | SOUL pm |
| CREATE | `.agents/designer/SOUL.md` | SOUL designer |
| CREATE | `.agents/architect/SOUL.md` | SOUL architect |
| CREATE | `.agents/qa/SOUL.md` | SOUL qa |
| MODIFY | `src/mcp/server.js` | +5 tools (enqueue_job, list_jobs, cancel_job, set_mode, get_mode) |
| MODIFY | `src/server/routes.js` | +2 endpoints (POST /api/jobs, POST /api/jobs/:id/kill) |
| MODIFY | `src/server/bullmq.js` | Adapter queues pour la queue unique `agents` |
| MODIFY | `docker-compose.yml` (services) | Exposer Redis sur IP privée |

## Plane — Work Items

Épique parent : **DEVPA-40** — Job Runner BullMQ — Équipe agents autonome H24

| ID | Priorité | Tâche |
|----|----------|-------|
| DEVPA-41 | high | Exposer Redis sur IP privée du serveur services |
| DEVPA-42 | urgent | Créer le worker process BullMQ (src/worker/) |
| DEVPA-43 | urgent | Ajouter les tools jobs dans le MCP DevPanel |
| DEVPA-44 | high | Ajouter les endpoints API pour enqueue et kill jobs |
| DEVPA-45 | high | Créer les SOUL files de tous les agents |
| DEVPA-46 | high | Pipeline de validation : builder → reviewer → merge |
| DEVPA-47 | high | Mode autonome/collaboratif + morning review |
| DEVPA-48 | medium | Crons automatiques (daily sync, sprint plan, health) |
| DEVPA-49 | medium | Service systemd pour le worker sur serveur agents |
| DEVPA-50 | medium | Adapter src/server/bullmq.js pour la queue unique agents |
