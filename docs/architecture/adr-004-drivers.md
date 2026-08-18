# ADR-004 v2 — Drivers : moteur model-agnostic, Claude en référence, plancher benché en validation

**Statut : DRAFT v2 — remplace la v1 « claude natif seul », overruled par Franck le 2026-08-18 (requirement produit).**
Réfs : engine-contract v1.1 (§4.2, §6, §11 amendés) ; mémoires `pi_canary_zeno339`, `agent_harness_research_2026-05-09`, incident 2026-08-11.

## Contexte

**Requirement produit (pour l'historique) : devpanl DOIT fonctionner avec d'autres LLMs que Claude** — pi (Qwen3, DeepSeek, …). Le retour au claude natif le 11/08 était un repli opérationnel (« ça marchait un peu mieux »), pas une cible : le résultat reste loin de l'attendu, et un modèle très capable **masque les faiblesses du moteur**. Si le pipeline ne réussit qu'avec le meilleur modèle du marché, c'est le modèle qui travaille, pas le moteur — on perd l'instrument de mesure, et le produit perd sa raison d'être.

Constat consolidé des tests (mai → août) : **le moteur ne suffit pas, le harness est trop faible, les outils pas assez évolués.** C'est le problème à résoudre — pas à contourner en achetant du QI.

Historique factuel à ne pas re-litiger :
- goose : abandonné après benchmark (18 $ brûlés) — réintégration = nouveau benchmark, pas une envie.
- pi/Qwen3 : canary **vert** en multi-tier (ZENO-339 R3 : builder Qwen3 + reviewer Opus, 1,70 $ ; le reviewer a correctement rejeté un fix incomplet). Le pattern multi-tier fonctionne.
- Incident 11/08 (« spam de permissions Qwen ») : bug de **harness** (boucle d'approbation), pas de modèle. Idem le false-flag « binaire » de qwen-code sur un JS de 70 KB : bug d'outillage d'édition.

## Décision

1. **Le moteur est model-agnostic par contrat.** Un « driver contract » formel : `spawn(prompt, tools, limites)` → flux d'événements (usage tokens, tool calls) → enveloppe v1 sur stdout → sémantique de kill (SIGTERM/grâce/SIGKILL) et codes de sortie. Tout ce que le contrat moteur exige (timeout §5, budget §6, cancel §7) s'appuie **uniquement** sur ce contrat — jamais sur un comportement propre à Claude. Un driver incapable d'exposer son usage tokens est inéligible au chemin critique.

2. **Deux drivers au chemin critique : claude = référence, pi = plancher.** Claude mesure le plafond atteignable ; pi (Qwen3/DeepSeek via DeepInfra) mesure si **le moteur** porte le travail. goose et mini-swe restent hors chemin critique (quarantaine, pas de suppression).

3. **Le bench est une matrice : D1–D6 × {claude, pi}.** La définition de « moteur prêt » = **la colonne plancher passe**. Colonne claude verte + colonne pi rouge ≠ moteur validé — c'est la mesure exacte du masquage redouté, et un signal d'où renforcer le harness. (D5 cancel et D6 réconciliation sont driver-agnostiques : une seule exécution.)

4. **Le harness devient un chantier nommé** (il était implicite dans « le moteur ») : application d'édits robuste, surface d'outils minimale et vérifiable par le moteur, auto-approve sandboxé (le spam du 11/08 devient structurellement impossible), compaction de contexte, usage exposé. Les faiblesses déjà documentées en mémoires (edit false-flag, permission loop, MCP bridge) deviennent des work items du backlog harness, pas du folklore.

5. **Multi-tier par rôle = stratégie nominale, pas fallback** : plancher pour builder/pm/designer, fort pour reviewer/qa/architect (validé ZENO-339 R3 — le reviewer fort attrape ce que le builder plancher rate). `DRIVER_<ROLE>` reste le routing ; `FORCE_TIER=opus` reste le kill switch global.

6. **Quota épuisé → bascule vers le plancher benché** (mécanique `shelly-switch` existante) — plus jamais vers un harness non benché. La pause n'est que le dernier recours si le plancher est aussi indisponible.

7. **Container = cible d'isolation pour TOUS les drivers** (l'auto-approve sandboxé de la décision 4 en dépend). Gated : fix NODE_ENV + git identity + suite de tests + canary. Après Phase D.

## Conséquences

- (+) La force du moteur devient **mesurable et opposable** (matrice de bench) ; le modèle cesse d'être la variable cachée.
- (+) Multi-tier divise le coût des rôles volumineux et colle à la réalité quota (Max ~220k tokens/5 h vs ~1M/5 h de besoin fleet).
- (−) La matrice de test du chemin critique double (×2 drivers). C'est le prix du requirement — assumé.
- (−) Le plancher impose des exigences au moteur : retry-with-feedback d'enveloppe (contrat §4.2 v1.1), prompts plus structurés, outils plus stricts. C'est voulu : **ces exigences SONT le renforcement du moteur.**
- (−) Séquencement Zeno V2 : si la colonne plancher n'est pas verte au moment du go, le refacto démarre en multi-tier (builder plancher là où le bench passe, sinon claude) — décision explicite de Franck, en connaissance du masquage.

## Alternatives rejetées

- **Claude-only sur le chemin critique** (v1 de cet ADR) : overruled — masque le moteur, contredit le produit.
- **Abstraction au niveau API type LiteLLM** : le problème n'est pas l'API des modèles, c'est le harness (édits, tools, permissions, usage). C'est l'agent-CLI qu'on met sous contrat, pas le endpoint HTTP.
- **Re-litiger goose / adopter mini-swe maintenant** : pas sans benchmark (mémoire 2026-05-09) ; le chemin critique n'accueille que du benché.

## Questions ouvertes (Franck)

1. Le plancher officiel du bench : **Qwen3-Coder via DeepInfra** (l'existant) ou tu veux DeepSeek en second plancher dès maintenant ? (Proposition : Qwen3 seul d'abord — un plancher à la fois.)
2. Colonne plancher exigée verte sur **D1–D4 complets** avant Zeno, ou D1–D2 suffisent pour démarrer en multi-tier ? (Proposition : D1–D2 pour le go multi-tier, D3–D4 avant de monter `max_parallel`.)
