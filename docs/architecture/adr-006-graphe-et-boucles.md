# ADR-006 — Le modèle d'exécution : graphe explicite, boucles bornées, prédicats vérifiés

**Statut : DRAFT — à valider.** Réfs : engine-contract v1.1 (§4, §11) ; ADR-001 (graphe inter-items) ; ADR-005 (harness, H1–H9) ; requirement Franck 2026-08-18 (« we need graph, and looping system »).

## Contexte

Le workflow intra-item actuel (`work-item.yaml`) est une **liste linéaire** de steps avec des transitions `on:` — les cycles y existent mais en contrebande : `reviewer failed → next: builder` est une boucle sans nom, bornée par un unique compteur global (`max_revisions: 3`) qui ne distingue pas *quelle* boucle tourne, et dont le prédicat de sortie est implicite. Résultat : impossible d'exprimer proprement « itère jusqu'à tests verts », « branche en parallèle reviewer + qa puis joins », ou « boucle de convergence avec budget propre » — et impossible de raisonner sur la terminaison.

Trois niveaux de graphe coexistent dans devpanl et ne doivent pas être confondus :

| Niveau | Nature | Source | Statut |
|---|---|---|---|
| **Inter-items** | dépendances `blocked_by`, vagues | Plane (données) | ADR-001 — décidé |
| **Intra-item** | étapes d'agents, branches, boucles | YAML (définition) | **cet ADR** |
| **Intra-job** | boucle test→fix dans UNE session d'agent | harness | **cet ADR + ADR-005 H9** |
| *(Subject graph / constellation)* | *lineage de données (captures, PRs, memories)* | *table subjects* | *existant, hors scope exécution* |

## Décision 1 — le workflow devient un graphe explicite

Le YAML évolue : `steps:` (liste) → `nodes:` + transitions, où **les boucles sont des constructs de premier ordre**, plus des cycles implicites :

```yaml
name: work-item
nodes:
  - id: build
    agent: builder
  - id: review
    agent: reviewer
  - id: qa
    agent: qa

loops:
  - id: revision
    body: [build, review]          # le cycle nommé
    until: review.done             # prédicat de sortie
    max_iterations: 3              # borne dure
    budget_tokens: 400000          # budget propre à LA boucle
    on_exhaustion: block

edges:
  - { from: build, on: done, to: review }
  - { from: review, on: failed, when: reviewer_rejected_pr, to: build }   # appartient à loop revision
  - { from: review, on: done, to: qa }
  - { from: qa, on: done, terminal: true }
  # blocked → replan : inchangé (ambiguity, contrat §4.2)
```

**Règle de validation au chargement (le validateur existe déjà, on l'étend) : tout cycle du graphe DOIT appartenir à une boucle déclarée — avec `until` ET `max_iterations` ET budget.** Un YAML avec un cycle non déclaré est rejeté au boot. La terminaison redevient démontrable : c'est la règle anti-11/08 au niveau du modèle d'exécution.

Branches parallèles + join (`needs: [a, b]`) font partie du modèle mais **pas du premier incrément** — le refacto Zeno n'en a pas besoin ; le format les prévoit pour ne pas re-casser le schéma.

## Décision 2 — deux niveaux de boucle, le bon travail au bon étage

- **Boucle interne (intra-job, harness — la moins chère).** Le builder itère test→fix **dans sa session** : contexte préservé, pas de re-spawn, pas de re-lecture du repo. Exigence harness **H9** (ajoutée à ADR-005) : le harness sait exécuter la commande de test déclarée (`.devpanlrc.json#commands.test`, ADR-003 R1), re-présenter l'échec au modèle, et itérer — borné par le timeout/budget du job (contrat §5–§6). C'est là que « looping system » rapporte le plus, surtout pour un modèle plancher.
- **Boucle externe (inter-jobs, engine).** La boucle `revision` ci-dessus : cycles entre agents distincts, chacun avec son contexte frais. Plus chère, réservée à ce qui exige un regard indépendant (review). Bornes et budget PAR BOUCLE, plus un compteur global anonyme.

## Décision 3 — les prédicats de sortie sont vérifiés, pas déclarés

Une boucle qui sort sur la parole de l'agent (« tests_passed: true ») reproduit le problème de confiance que le commit-authority a déjà réglé pour les commits. Donc : **quand un prédicat est mécanisable, le worker le vérifie lui-même** — `tests_green` = le worker exécute `commands.test` dans le worktree (même philosophie que `verifyAndCommit` : vérifier, pas croire). Les prédicats non mécanisables (`review.done`) restent des sorties d'enveloppe — c'est le rôle du reviewer d'être ce prédicat.

## Décision 4 — conformité

Le bench gagne un scénario : **D7 — convergence de boucle** : (a) un item conçu pour exiger 2 itérations converge et sort par `until` ; (b) un item conçu pour ne jamais converger est arrêté par `max_iterations` + budget, termine `exhausted`, notifie — sur les DEUX colonnes de la matrice (référence + plancher). Le validateur de graphe (cycle non déclaré = rejet) est couvert par un test unitaire, pas par le bench.

## Conséquences

- (+) La terminaison de tout workflow devient démontrable au chargement ; « pourquoi ça boucle ? » devient une question de lecture de YAML, plus d'archéologie de logs.
- (+) La boucle interne H9 est le plus gros levier de qualité du modèle plancher (itérer coûte moins cher que rater) — alignement direct avec ADR-004.
- (+) `max_revisions` actuel = cas particulier du nouveau modèle → migration mécanique des 4 YAMLs existants.
- (−) C'est le chantier de build le plus lourd de la Phase C (engine + validateur + migration + D7). À séquencer : le format graphe d'abord (compatible), les branches parallèles plus tard.
- (−) H9 dépend des commandes déclarées (ADR-003 R1) — un repo sans `.devpanlrc.json#commands` n'a pas de boucle interne vérifiée (fallback : parole d'agent + revue forte, signalé au readiness).

## Alternatives rejetées

- **Adopter un moteur de graphe externe (LangGraph-style)** : notre graphe est petit (≤ 10 nœuds), nos besoins précis (bornes, budgets, prédicats vérifiés) ; le coût d'intégration + la perte du validateur maison dépassent le gain. Même verdict que « pas de DAG engine » (ADR-001), au niveau intra-item.
- **Boucles au niveau prompt uniquement** (« itère jusqu'à vert » écrit dans le SOUL) : non vérifiable, non borné, invisible du moteur — c'est le statu quo qui a produit les boucles muettes.
- **Tout en boucle externe** : re-spawn systématique = payer le contexte à chaque itération ; la boucle interne existe précisément pour éviter ça.

## Questions ouvertes (Franck)

1. Budget de boucle en tokens (proposé) ou en itérations seulement ? (Tokens = la vraie ressource, mais exige H6 partout.)
2. Premier incrément : boucle `revision` + H9 seulement, ou tu veux les branches parallèles dès la V1 du nouveau format ?
