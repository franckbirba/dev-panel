# Architecture — Skills, Plugins & Jobs

## AI Dev Team — Référence universelle

-----

## Vue d’ensemble

```
┌─────────────────────────────────────────────────────────────────┐
│                        BullMQ Job                               │
│                                                                 │
│  {                                                              │
│    agent: "builder",                                            │
│    task: "TASK-42",                                             │
│    plugins: [...],   ← ACCÈS OUTILLÉ (avec quoi tu travailles) │
│    skills:  [...]    ← COMPORTEMENT   (comment tu travailles)   │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

**Plugins** = accès MCP aux outils externes (Plane, Penpot, GitHub…)
**Skills** = instructions comportementales (conventions, patterns, formats)
**Jobs** = unité de travail BullMQ qui orchestre agents + plugins + skills

Ces trois éléments sont **universels** — ils s’appliquent identiquement à chaque projet. Seul `plugin-project-context` est généré par projet au bootstrap.

-----

## 1. Les Plugins

Un plugin Claude Code expose des outils MCP à un agent pour qu’il puisse lire et écrire dans un système externe.

### Plugins universels (tous projets)

|Plugin           |Système |Capacités                                      |
|-----------------|--------|-----------------------------------------------|
|`plugin-plane`   |Plane   |issues, cycles, sprints, pages, roadmap        |
|`plugin-affine`  |AFFiNE  |docs privés, SOUL.md, MISSIONS.md, workspaces  |
|`plugin-penpot`  |Penpot  |frames, design tokens, composants, commentaires|
|`plugin-devpanel`|DevPanel|feedbacks, statuts, users, tickets             |
|`plugin-github`  |GitHub  |issues, PRs, reviews, branches, labels         |
|`plugin-pgvector`|Postgres|store/query embeddings, mémoire sémantique     |
|`plugin-bullmq`  |Redis   |trigger jobs, check queues, dead letters       |

### Plugin projet (généré au bootstrap)

|Plugin                  |Généré par    |Contenu                                   |
|------------------------|--------------|------------------------------------------|
|`plugin-project-context`|`project:init`|stack, URLs, IDs, conventions, credentials|

-----

### Structure d’un plugin

```
.claude/
└── plugins/
    └── plugin-plane/
        ├── plugin.md        ← description + instructions d'usage
        └── mcp.json         ← config MCP (url, auth, tools exposés)
```

**plugin.md** — exemple pour plugin-plane :

```markdown
# Plugin — Plane

## Ce que ce plugin expose
Accès complet à Plane pour lire et écrire issues, cycles,
sprints, pages et roadmap du projet courant.

## Quand l'utiliser
- Lire une spec ou user story → `get_issue`
- Créer une issue qualifiée → `create_issue`
- Mettre à jour un statut → `update_issue_status`
- Lire le sprint courant → `get_active_cycle`
- Créer une page de doc → `create_page`

## Workflow standard
1. Toujours lire l'issue complète avant d'agir
2. Mettre à jour le statut AVANT de commencer ("in_progress")
3. Mettre à jour le statut APRÈS livraison ("done" ou "in_review")
4. Lier chaque issue à la GitHub PR correspondante

## Ne jamais faire
- Supprimer une issue sans validation Shelly
- Changer de cycle une issue sans validation Agent PM
- Créer des issues dupliquées (vérifier d'abord avec `search_issues`)
```

**mcp.json** :

```json
{
  "mcpServers": {
    "plane": {
      "type": "http",
      "url": "${PLANE_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${PLANE_API_TOKEN}"
      }
    }
  }
}
```

-----

### Plugin projet — plugin-project-context

Généré automatiquement par la commande `project:init`. C’est le seul plugin qui change par projet.

```markdown
# Plugin — Project Context : {project-name}

## Stack technique
- Frontend  : Vite + React + Tailwind + Zustand
- Backend   : Express + MongoDB + PostgreSQL
- Auth      : Permify (workspace: {permify-workspace-id})
- Cache     : Redis
- Queue     : BullMQ

## Repositories
- GitHub org  : {github-org}
- Repo        : {github-repo}
- Branch main : main
- Branch dev  : develop

## Services projet
- Plane workspace  : {plane-workspace-slug}
- Plane project    : {plane-project-id}
- Penpot project   : {penpot-project-id}
- AFFiNE workspace : {affine-workspace-id}
- DevPanel project : {devpanel-project-id}

## Membres
- Lead Dev  : Franck
- Designer  : {designer-name} ({penpot-user})
- PM humain : {pm-name} ({plane-user})

## Conventions
→ Voir skill : stack-conventions
→ Voir skill : write-component
→ Voir skill : write-api-route

## Variables d'environnement
→ Chargées depuis Vault au démarrage du job
→ Ne jamais hardcoder de credentials
```

-----

## 2. Les Skills

Un skill est un fichier `.md` qui définit **comment** un agent doit travailler. Il ne donne pas accès à des outils — il donne des instructions comportementales.

### Skills universels (tous projets, tous agents)

```
.claude/
└── skills/
    ├── stack-conventions.md     ← structure, naming, patterns JS
    ├── write-component.md       ← générer un composant React/Tailwind
    ├── write-api-route.md       ← générer une route Express
    ├── write-pr.md              ← format PR, checklist, liens
    ├── write-github-issue.md    ← format issue, labels, critères
    ├── write-plane-issue.md     ← format issue Plane, priorité, cycle
    ├── read-penpot-frame.md     ← extraire specs depuis une frame
    ├── read-affine-doc.md       ← lire et interpréter un doc AFFiNE
    ├── devpanel-update.md       ← mettre à jour statuts DevPanel
    └── mermaid-diagram.md       ← générer des diagrammes Mermaid
```

### Structure d’un skill

```markdown
# Skill — write-component

## Quand utiliser ce skill
Quand tu génères un composant React à partir d'une frame Penpot
ou d'une spec AFFiNE.

## Process
1. Lire la frame Penpot (plugin-penpot)
2. Extraire : nom, props, états, design tokens
3. Générer le composant selon les conventions ci-dessous
4. Générer le fichier de test associé
5. Mettre à jour DevPanel (plugin-devpanel)

## Conventions composant
- Fichier : src/components/{Feature}/{ComponentName}.jsx
- Test    : src/components/{Feature}/{ComponentName}.test.jsx
- Style   : Tailwind uniquement, pas de CSS inline
- State   : Zustand si state global, useState si local
- Props   : toujours typées avec PropTypes ou JSDoc

## Template
```jsx
// src/components/{Feature}/{ComponentName}.jsx
import { useState } from 'react'

/**
 * @param {Object} props
 * @param {string} props.xxx - description
 */
export function {ComponentName}({ xxx }) {
  return (
    <div className="">
      {/* ... */}
    </div>
  )
}
```

## Checklist avant PR

- [ ] Composant généré selon conventions
- [ ] Props documentées
- [ ] Test unitaire présent
- [ ] Lien Penpot frame dans le commentaire PR
- [ ] Lien Plane issue dans le commentaire PR

```
---

## 3. Les Jobs BullMQ

Un job est l'unité d'exécution qui déclenche Claude Code avec le bon contexte.

### Structure d'un job

```javascript
// Exemple : job Builder sur une tâche feature UI
{
  // Identité du job
  queue: "build:task",
  jobId: "build-TASK-42-{timestamp}",

  // Quel agent
  agent: "builder",

  // Contexte de la tâche
  task: {
    id: "TASK-42",
    title: "Créer composant ProductCard",
    type: "FEATURE_UI",
    priority: "P1",
    plane_issue_id: "ISS-123",
    penpot_frame_id: "frame-abc",
    affine_doc_id: "doc-xyz",
    github_repo: "org/project-x",
    branch: "feature/product-card"
  },

  // Plugins injectés (accès outils)
  plugins: [
    "plugin-project-context",  // toujours en premier
    "plugin-plane",            // lire la spec
    "plugin-penpot",           // lire le design
    "plugin-github",           // ouvrir la PR
    "plugin-devpanel"          // mettre à jour le statut
  ],

  // Skills injectés (comportement)
  skills: [
    "stack-conventions",
    "write-component",
    "read-penpot-frame",
    "write-pr"
  ],

  // Retry strategy
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },

  // Timeout
  timeout: 1800000, // 30min max

  // Dead letter
  onFailure: "shelly:escalate"
}
```

### Catalogue des queues

|Queue             |Déclencheur                     |Agents   |Priorité|
|------------------|--------------------------------|---------|--------|
|`shelly:triage`   |message Franck / ticket DevPanel|Shelly   |immédiat|
|`pm:sprint-plan`  |cron Monday 8h00                |PM       |normal  |
|`pm:daily-sync`   |cron daily 7h00                 |PM       |normal  |
|`pm:issue-qualify`|on-demand via Shelly            |PM       |high    |
|`design:sprint`   |on-demand via PM                |Designer |normal  |
|`arch:review`     |on-demand via Shelly            |Architect|high    |
|`secu:check`      |bloquant avant build            |Secu     |high    |
|`build:task`      |on tâche assignée               |Builder×N|normal  |
|`review:pr`       |on GitHub PR opened             |Reviewer |high    |
|`qa:run`          |on PR merged                    |QA       |normal  |
|`devpanel:notify` |on task done                    |Shelly   |low     |
|`backup:nightly`  |cron 2h00                       |—        |low     |
|`health:check`    |cron every 5min                 |—        |critical|

### Plugins par agent

|Agent    |Plugins systématiques                    |Plugins conditionnels|
|---------|-----------------------------------------|---------------------|
|Shelly   |tous                                     |—                    |
|PM       |plane, affine, devpanel, github, pgvector|—                    |
|Architect|affine, github, pgvector                 |penpot (si UI)       |
|Designer |penpot, affine, pgvector                 |—                    |
|Builder  |plane, penpot, github, devpanel, pgvector|affine (si ADR)      |
|Reviewer |github, plane, penpot, affine            |—                    |
|QA       |github, devpanel, pgvector               |—                    |
|Secu     |affine, github, pgvector                 |devpanel             |

-----

## 4. Le Bootstrap projet — `project:init`

La commande Claude Code qui génère tout le contexte d’un nouveau projet.

```bash
/project:init
```

### Ce qu’elle fait

```
1. Demande à Franck les infos du projet :
   - Nom, description, client
   - Stack (confirmée ou custom)
   - Designer humain (Penpot username)
   - PM humain (Plane username)

2. Crée les espaces :
   → Plane : workspace + projet + cycles
   → Penpot : projet + fichier design système
   → AFFiNE : workspace + docs initiaux
   → DevPanel : projet + config feedback
   → GitHub : repo + branch main/develop + labels

3. Génère les fichiers projet :
   → .claude/plugins/plugin-project-context/plugin.md
   → .agents/MISSIONS.md (vide, prêt pour PM)
   → docs/ADR-000-stack.md (stack décidée)
   → docs/conventions.md (lien vers skills)
   → README.md

4. Génère MISSIONS.md initial pour Agent PM :
   → "Projet initialisé, en attente des user stories"

5. Notifie Shelly → Shelly confirme à Franck
```

-----

## 5. Arbre de fichiers universel

```
project-root/
│
├── .claude/
│   ├── plugins/
│   │   ├── plugin-project-context/
│   │   │   ├── plugin.md          ← généré par project:init
│   │   │   └── mcp.json
│   │   ├── plugin-plane/
│   │   ├── plugin-affine/
│   │   ├── plugin-penpot/
│   │   ├── plugin-devpanel/
│   │   ├── plugin-github/
│   │   ├── plugin-pgvector/
│   │   └── plugin-bullmq/
│   │
│   ├── skills/
│   │   ├── stack-conventions.md
│   │   ├── write-component.md
│   │   ├── write-api-route.md
│   │   ├── write-pr.md
│   │   ├── write-github-issue.md
│   │   ├── write-plane-issue.md
│   │   ├── read-penpot-frame.md
│   │   ├── read-affine-doc.md
│   │   ├── devpanel-update.md
│   │   └── mermaid-diagram.md
│   │
│   └── commands/
│       ├── project:init.md
│       ├── project:sync-design.md
│       ├── project:spec.md
│       ├── project:review.md
│       ├── project:qa.md
│       └── project:status.md
│
├── .agents/
│   ├── shelly/SOUL.md
│   ├── pm/SOUL.md
│   ├── architect/SOUL.md
│   ├── designer/SOUL.md
│   ├── builder/SOUL.md
│   ├── reviewer/SOUL.md
│   ├── qa/SOUL.md
│   └── secu/SOUL.md
│
├── docs/                          ← miroir AFFiNE (privé)
│   ├── ADR-000-stack.md
│   ├── ADR-001-*.md
│   └── conventions.md
│
├── design/                        ← exports Penpot
│   ├── tokens.json
│   └── components-specs.md
│
├── MISSIONS.md                    ← objectif sprint courant (Agent PM)
└── src/                           ← code
```

-----

## 6. Règles fondamentales

```
1. Un job = un agent = un livrable clair
2. plugin-project-context est toujours le premier plugin chargé
3. Jamais de credentials hardcodés → Vault uniquement
4. Tout échec job → dead letter queue → escalade Shelly
5. Les skills ne changent pas par projet — seul plugin-project-context change
6. Un agent ne contacte jamais Franck directement → passe par Shelly
7. Tout état de tâche est mis à jour dans DevPanel avant ET après exécution
8. Les docs AFFiNE sont en append-only — jamais de modification de blocs existants
9. Source of truth : Plane (produit), AFFiNE (privé), Penpot (design),
                     GitHub (code), DevPanel (feedback), pgvector (mémoire)
```