# ADR-005 — Le harness : la couche invisible qui porte tout

**Statut : DRAFT — à valider.** Réfs : ADR-004 v2 (décision 4 : « le harness devient un chantier nommé » — ce document EST ce chantier) ; engine-contract v1.1 §5–§6 ; mémoires `agent_harness_research`, `bernstein_qwen3_devpa181`, `pi_mcp_bridge`, incident 2026-08-11.

## Contexte

Trois couches, trois responsabilités — aujourd'hui confondues sous le mot « moteur » :

| Couche | Responsabilité | Chez nous |
|---|---|---|
| **Moteur** | orchestrer des jobs (états, échecs, vagues, gates) | worker + engine YAML — spécifié par engine-contract |
| **Harness** | exécuter UN job : boucle d'outils, édits, contexte, permissions, sortie | claude-code CLI ou pi + extensions — **jamais spécifié** |
| **Modèle** | prédire | Claude / Qwen3 / DeepSeek — interchangeable par ADR-004 |

Le diagnostic « le moteur ne suffit pas, le harness trop faible, les outils pas assez évolués » se répartit précisément : chaque incident documenté est une défaillance d'UNE capacité de harness identifiable —

| Incident documenté (mémoire) | Capacité de harness défaillante |
|---|---|
| qwen-code false-flag « binaire » sur un JS de 70 KB | application d'édits (H2) |
| 11/08 — spam de permissions Qwen, containment | gestion des permissions (H4) |
| enveloppe non émise → rescue commits à répétition | sortie structurée forcée (H3) |
| budget tokens impossible à enforcer | usage non exposé (H6) |
| pi 0.74 : zéro MCP natif → `mcp-bridge` vendored en urgence | surface d'outils (H7) |
| goose : 18 $ brûlés sans tool call fiable | boucle d'outils (H1) |
| NODE_ENV=production hérité → devDeps manquants, lockfile drift | environnement déterministe (H8) |
| Bernstein : override silencieux du `role_model_policy.model` | configuration honnête (H8) |

**claude-code CLI est le seul harness complet qu'on ait — et il est mono-modèle.** C'est exactement pourquoi Claude « masque » le moteur (ADR-004) : il masque en réalité l'absence de harness. pi est multi-modèle mais harness minimal. Ce trou entre les deux est le cœur technique de devpanl.

## Décision 1 — le harness contract : H1–H9

Tout harness du chemin critique DOIT fournir :

- **H1. Boucle d'outils fiable** — tool calls parsés, exécutés, résultats re-présentés au modèle ; une erreur d'outil revient au modèle comme information, jamais comme crash.
- **H2. Application d'édits robuste** — patch avec vérification post-application (le fichier contient ce que l'édit prétend), pas de faux « binaire », fichiers larges supportés.
- **H3. Sortie structurée forcée** — l'enveloppe v1 émise via un mécanisme contraint (tool call dédié ou grammaire), pas « imprime du JSON s'il te plaît ». C'est ce qui rend le retry-with-feedback (§4.2 v1.1) rarement nécessaire au lieu de fréquent.
- **H4. Permissions : auto-approve total en sandbox** — un job headless ne pose JAMAIS de question interactive ; la sécurité vient de l'isolation (container, ADR-004 §7), pas de prompts. Le 11/08 devient structurellement impossible.
- **H5. Gestion de contexte** — compaction/priorisation quand le job dépasse la fenêtre du modèle plancher.
- **H6. Usage exposé en flux** — tokens in/out consommables par le moteur (requis par contrat §6 ; un harness muet est inéligible).
- **H7. Surface MCP studio** — accès aux tools devpanl avec le naming stable `mcp__server__tool` (pattern `mcp-bridge` existant).
- **H8. Environnement déterministe et honnête** — env nettoyé (NODE_ENV, git identity), cwd = worktree, secrets injectés explicitement, configuration appliquée telle que déclarée (jamais d'override silencieux).
- **H9. Boucle interne outillée** (ADR-006 décision 2) — exécuter la commande de test déclarée (`.devpanlrc.json#commands.test`, ADR-003 R1), re-présenter l'échec au modèle, itérer dans la même session — borné par le timeout/budget du job. Le plus gros levier de qualité pour un modèle plancher : itérer coûte moins cher que rater.

**Le bench matrice (contrat §11) est aussi le bench du harness** : D1–D4 + D7 sur le plancher exercent H1–H9. Un gap de harness se lit dans la colonne pi avant de se raconter en post-mortem.

## Décision 2 — build-vs-adopt : **O1 DÉCIDÉ (Franck, 2026-08-18 : « on investit sur pi »)**

- **O1 — pi + nos extensions (RETENU).** Actifs existants, inventoriés : 7 extensions vendored dans `infra/pi-extensions/` — `mcp-bridge` (496 LOC), `telegram-out` (535), `github` (427), `work-items` (417), `bash` (222), `create-file` (193), `loop-guard` (148) — ~2 400 LOC TS ; plus `pi-driver` avec `--mode json` natif et l'allowlist d'outils builtin `read,edit,grep,find,ls,bash`. On ne part pas de zéro : on capitalise.
- **O2 — harness minimal maison** : voie de sortie **si et seulement si** les gaps H2/H3 s'avèrent structurels dans pi (non comblables par extension). Les extensions se réutilisent telles quelles — elles sont déjà découplées.
- **O3 — autre harness OSS** : uniquement sur benchmark comparatif — l'historique (goose 18 $, Bernstein RED) a déjà payé cette leçon deux fois.

L'ordre O1 → O2 est réversible à un endroit précis : **le verdict du bench plancher**. Pas de re-litige au feeling.

### État de départ pi vs H1–H9 (à confirmer par l'audit C7)

| Capacité | État de départ | Base |
|---|---|---|
| H1 boucle d'outils | à mesurer (canary mai vert) | builtins + extensions |
| H2 édits robustes | meilleur que craint — `edit` builtin **Aider-style SEARCH/REPLACE**, validé au spike 05-09 (12 édits corrects) ; le false-flag 70 KB était qwen-code, pas pi. Reste : stress-test gros fichiers/multi-hunk/apostrophes FR | builtin `edit` |
| H3 sortie structurée | **gap mesuré** — pas de json_schema en pi 0.74 ; l'enveloppe est lâchée ~70 % des longs runs, mitigé par la synthèse git côté driver. Cible : tool dédié `submit_result` | `synthesizePiResult` (pi-driver.js:48) |
| H4 auto-approve sandboxé | **gap réel** — le spam de permissions du 11/08 venait du chemin Shelly-pi ; jobs headless à auditer zéro-prompt | à construire |
| H5 contexte/compaction | gap probable — one-shot `--no-session`, pas de compaction | à auditer |
| H6 usage exposé | **partiel bon** — usage cumulatif émis par pi à chaque message, suivi live par le shim ; reste l'enforcement mid-run du budget §6 | pi-stream-shim.js:39,91,183 |
| H7 surface MCP | ✅ le plus avancé (+ `compositeReplaces` : une capacité = une seule surface) | mcp-bridge |
| H8 env déterministe | ⚠️ **fuite réelle** : `{...process.env}` propage le NODE_ENV=production du host dans les jobs (le trap lockfile du 11/08) ; fix ~5 lignes | pi-driver.js:251 |
| H9 boucle interne outillée | à construire — base naturelle : extension `bash` + `commands.test` | ext `bash` |

**Architecture complète du harness retenu : [`harness-pi.md`](harness-pi.md)** (anatomie, flux, chantiers C7 priorisés).

## Conséquences

- (+) « Harness trop faible » cesse d'être un ressenti : c'est un scorecard H1–H8, mesuré par la même matrice de bench que le moteur.
- (+) Le harness devient un actif du studio — potentiellement LA brique OSS extractable de devpanl (un harness multi-modèle honnête est exactement le trou du marché constaté).
- (−) L'audit pi vs H1–H8 est un vrai chantier de Phase C (estimation : 1–2 j d'audit + le comblement des gaps découverts).
- (−) H4 (auto-approve total) rend le container (isolation) prioritaire dans la roadmap post-bench — la sécurité par sandbox remplace la sécurité par prompts.

## Questions ouvertes (Franck)

1. ~~O1 vs O2~~ — **tranché : O1, on investit sur pi** (2026-08-18).
2. Comblement des gaps : extensions privées d'abord (rapide, on maîtrise), upstream ensuite si générique — proposition par défaut, dis si tu préfères contribuer upstream direct.
