# ADR-002 — Contrats agents : enveloppe de sortie, SOUL layering, matrice de capacités

**Statut : DRAFT — à valider.** Réfs : engine-contract §3.1, §4 ; audit 2026-08-18 F9.

## Contexte

Trois contrats implicites gouvernent les agents éphémères, aucun n'est spécifié :
1. **L'enveloppe de sortie** existe dans le code (`parseResult`, `prompt-builder.js:146-192`) mais nulle part en doc — les souls la paraphrasent, avec dérive.
2. **Les SOULs** sont lus exclusivement depuis dev-panel (`prompt-builder.js:17,85`) : un builder qui travaille sur Zeno reçoit l'identité… de dev-panel. Impossible d'injecter les conventions Zeno V2 (kernel, gabarit ZenoModule, NATS, Permify).
3. **Les permissions par rôle** (le reviewer ne pushe pas, le builder ne merge pas, seul le worker commite) vivent en prose dans les souls — non vérifiables, déjà violées par le passé (audit drift 2026-04-22 : Shelly avait Read/Grep).

## Décision

### 1. L'enveloppe de sortie devient un schéma versionné et gelé

Le format actuel est canonisé tel quel en **v1** (on ne casse pas ce qui marche) :

```json
{"status":"done|blocked|failed","summary":"...",
 "artifacts":{"files_created":[],"files_modified":[],"commits":[],"branch":null,"tests_passed":false,"pr_url":null},
 "handoff":{"next_agent":null,"reason":""},
 "memory_writes_count":0,"blockers":[],"issues_found":[]}
```

- Spécifié dans **ce fichier + un JSON Schema** (`docs/architecture/schemas/job-output.v1.json`) référencé par `parseResult`, les souls et le skill `job-output-contract` — une seule source, trois consommateurs.
- Enveloppe invalide = `agent_failure` (contrat moteur §4.2) : rescue si diff, jamais de retry auto.
- Toute évolution = v2 explicite + période de double-acceptation. Pas de champ ajouté « en douce » dans le prompt.

### 2. SOUL layering : studio → repo cible → work item

Le prompt d'un agent se compose dans cet ordre (le plus spécifique gagne) :

| Couche | Source | Contenu | Budget |
|---|---|---|---|
| L1 — rôle studio | dev-panel `.agents/<role>/SOUL.md` | identité, enveloppe, interdits universels | ≤ 6 000 car. |
| L2 — overlay repo | **repo cible** `.agents/<role>/SOUL.md` (s'il existe) | conventions du repo : archi, commandes test/build, style, pièges | ≤ 6 000 car. |
| L3 — contexte item | description Plane + parent-context | le travail lui-même | tel quel |

- `prompt-builder.js` lit L2 depuis `context.project_root` — fallback silencieux si absent (les repos non onboardés continuent de marcher).
- Les skills suivent la même règle : `required_skills` résolus d'abord dans le repo cible, puis dev-panel.
- `devpanl:init` (plugin) génère les L2 — pour Zeno : kernel backend, gabarit ZenoModule, NATS accounts par marque, Permify, conventions de test. Les L2 sont **dans le repo cible**, versionnés avec le code qu'ils décrivent.

### 3. Matrice de capacités par rôle — vérifiée, pas récitée

| Rôle | Écrit du code | Commit | Push/PR | Merge | Plane state | Dispatch |
|---|---|---|---|---|---|---|
| builder | ✅ (worktree) | ❌ (worker only) | ❌ (worker only) | ❌ | ❌ | ❌ |
| reviewer / qa | ❌ (lecture + exécution tests) | ❌ | ❌ | ❌ | ❌ | ❌ |
| architect / pm | ❌ | ❌ | ❌ | ❌ | ✅ (replan) | pm : ✅ |
| merge-coordinator | ❌ | ❌ | rebase only | ✅ (gates) | ✅ | ❌ |
| deploy | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ (allowlist requester) |

- Enforcement là où c'est mécanisable : le worker reste **seule autorité de commit/push/PR** (déjà le cas depuis 2026-05-08, on le garde) ; flags par rôle passés au driver (tools autorisés) ; le reste vérifié par le reviewer avec la matrice comme checklist.
- Les souls **référencent** la matrice au lieu de la paraphraser.

## Conséquences

- (+) F9 fermé proprement : Zeno V2 pilotable avec des agents qui connaissent Zeno.
- (+) La dérive des souls devient détectable : ils pointent vers des contrats uniques au lieu de les dupliquer.
- (−) Budget de prompt : L1+L2 ≤ 12 000 car. avant le contexte item — à surveiller au bench (D1).
- (−) Les L2 à écrire pour Zeno = un vrai livrable de la Phase E (via `devpanl:init` + relecture Franck).

## Alternatives rejetées

- **Souls générés par job par un analyzer** : magique, non relisible, coût par dispatch.
- **Un SOUL global unique par rôle** (statu quo) : c'est le bug F9.
- **Enforcement total des capacités dans le worker** : certaines contraintes (« le reviewer ne réécrit pas le code ») ne sont pas mécanisables sans sandboxing lourd — la matrice + le commit-authority couvrent le risque réel.
