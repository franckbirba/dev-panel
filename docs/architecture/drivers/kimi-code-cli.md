# Kimi Code CLI

`KimiCodeCliDriver` exécute **Kimi Code CLI** comme processus non interactif derrière `ExecutionAdapter`. Ce produit est distinct de l’application Kimi grand public et de Kimi Design. Une fonction observée dans l’application grand public ne prouve aucune capacité du CLI, et inversement. DevPanel n’appelle pas directement l’API Moonshot.

## Commandes cibles

Lancement d’un nouveau run :

```bash
kimi -p "<prompt>" --output-format stream-json
```

Reprise d’une session native identifiée :

```bash
kimi --session <native-session-id> -p "<prompt>" --output-format stream-json
```

Export d’une session native :

```bash
kimi export <native-session-id> --yes
```

Ces invocations sont les seules commandes retenues ici. Leur présence ne vaut pas attestation pour toutes les versions : avant le routage, l’opérateur vérifie leur syntaxe dans l’aide du binaire installé et réalise les tests ci-dessous. Aucune autre option n’est inventée ou copiée depuis Claude Code, OpenCode ou l’app Kimi.

## Stream, annulation et preuves

Le test `stream` vérifie le format réellement émis, le découpage des messages, les erreurs et le statut terminal avant de mapper les sorties vers [`ExecutionEvent`](../contracts/execution-event.schema.json). Les événements normalisés sont ordonnés, idempotents et expurgés ; les sorties volumineuses sont remplacées par des `artifact_ref`. Le mapping reste `unsupported` tant qu’un run représentatif n’a pas été validé.

L’annulation utilise le handle du processus détenu par le worker. Elle attend l’arrêt effectif, collecte les preuves disponibles et produit `cancelled` sans retry. Aucune option native d’annulation n’est supposée. Le code de sortie et le résumé de l’agent ne remplacent jamais `output_contract.acceptance_criteria`.

## Capacités dépendant de la version

Toutes les capacités du tableau sont `unsupported` par défaut. Le statut `verified` est limité au couple version/node ayant produit la preuve et est publié dans [`NodeRegistration`](../contracts/node-registration.schema.json).

| Capacité | Méthode de vérification | Preuve et statut attendus |
|---|---|---|
| `resume` | Créer une session avec un run court, récupérer son `native_session_id` non secret, puis utiliser exactement la commande de reprise ci-dessus avec une consigne vérifiable | `verified` si la même session continue, `ExecutionAdapter.resume` aboutit et un événement `resumed` est accepté ; sinon `unsupported` |
| `export` | Utiliser exactement `kimi export <native-session-id> --yes` sur la session du test, puis ouvrir le fichier obtenu | `verified` si le contenu est lisible, expurgé et couvert par un `ArtifactManifest(kind = session-export)` avec taille et SHA-256 ; sinon `unsupported` |
| `cron` | Consulter le mécanisme natif documenté par cette version et créer un rappel local de test sans effet externe, puis le supprimer | `verified` uniquement comme rappel natif local sur cette version ; aucune capacité de scheduling durable ou de production n’en est déduite |
| `goal` | Exécuter un objectif borné et non secret avec le mécanisme documenté par cette version, dans un worktree isolé | `verified` si l’objectif, les attentes, le résultat terminal et les artefacts sont observables et conformes au contrat ; une simple mention dans l’aide ne suffit pas |
| `multimodal` | Fournir une petite image non secrète par le mécanisme documenté de cette version et poser une question dont la réponse exige son contenu | `verified` si l’entrée est effectivement exploitée et si la preuve est rattachée au run ; sinon `unsupported` |
| `design` HTML/React | Soumettre un brief de référence via le run headless et exiger les sources, une preview, des screenshots et les états demandés | `verified` seulement après benchmark et `PrototypeRelease` complète ; cela ne vérifie pas Kimi Design dans l’app |

## Les crons natifs ne remplacent jamais Temporal

Un cron Kimi éventuellement vérifié sert uniquement de rappel local dans une session. **Temporal reste l’unique autorité des timers, schedules, attentes, reprises et actions critiques de production.** Une action ne doit jamais être programmée à la fois dans Temporal et dans un cron natif. L’indisponibilité du node local suit les règles Temporal de placement et de fallback, pas un scheduler Kimi parallèle.

## Placement et fallback

Les valeurs autorisées restent `local`, `cloud`, `preferred-local` et `any` pour le placement, puis `wait`, `cloud_fallback`, `escalate` et `deadline` pour le fallback. Les sessions et credentials locaux ne sont pas copiés vers le cloud. Un fallback exige les mêmes capacités vérifiées sur le nouveau node et respecte le budget, les permissions et la sensibilité des données.

Pour le design économique, Kimi Code HTML headless est un chemin distinct de [`KimiDesignBridge`](kimi-design-bridge.md). Le premier produit du code exécutable par CLI ; le second consomme un export de l’application Kimi grand public. Aucun des deux ne peut se substituer à l’autre sans capacité et preuves adaptées.
