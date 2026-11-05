# Claude Code CLI

`ClaudeCodeCliDriver` lance Claude Code comme processus non interactif derrière `ExecutionAdapter`. DevPanel n’appelle pas directement l’API Anthropic. Le driver reçoit un [`RunSpec`](../contracts/execution-run-spec.schema.json) complet et n’annonce que les capacités vérifiées sur la version installée.

## Lancement non interactif

La commande cible retenue est :

```bash
claude -p "<prompt>" --output-format stream-json --verbose
```

Avant de déclarer `process` ou `stream` comme `verified`, l’opérateur vérifie dans l’aide de la version installée que cette invocation et ses trois options sont prises en charge, puis exécute un smoke test dans le worktree du run. Aucune option supplémentaire n’est présumée. Le prompt et les artefacts d’entrée sont expurgés de secrets et les permissions effectives restent bornées par `RunSpec.permissions`.

## Événements et cycle de vie

Le driver lit la sortie JSON sans supposer que tous ses événements natifs correspondent déjà aux [`ExecutionEvent`](../contracts/execution-event.schema.json). Le test de version doit établir le mapping réel vers `started`, `stdout`, `stderr`, `tool_started`, `tool_finished`, `heartbeat`, `completed`, `failed` et `cancelled`, ainsi que les références d’artefacts.

Pour chaque `run_id`, les événements normalisés ont une séquence strictement croissante et des `event_id` idempotents. Les sorties sont expurgées avant persistance ; un extrait tronqué possède un `artifact_ref`. Un événement natif inconnu n’est pas transformé en succès ni en capacité implicite. Le statut terminal technique ne remplace pas les critères de `output_contract`.

### Annulation

`ExecutionAdapter.cancel(run_id)` agit sur le processus enfant possédé par le worker. Le driver demande son arrêt, surveille sa terminaison et collecte les artefacts déjà disponibles. Il n’invente pas de commande native d’annulation et n’émet `ExecutionEvent.cancelled` qu’une fois le processus effectivement arrêté. Une annulation ne déclenche ni retry automatique ni transition produit `done`.

## Reprise et export

Aucune commande de reprise ou d’export Claude n’est retenue par ce guide. Leurs statuts sont donc `unsupported` jusqu’à documentation de la version installée et test probant. Il est interdit de déduire ces commandes de Kimi Code ou d’un autre outil.

Un test de reprise doit démontrer la continuité de la session native et permettre `ExecutionAdapter.resume(run_id, input)` avec un événement `resumed`. Un test d’export doit produire un fichier lisible, expurgé et rattaché à un [`ArtifactManifest`](../contracts/artifact-manifest.schema.json) de kind `session-export`. Sans ces preuves, le workflow choisit explicitement un nouveau run, un arrêt ou une collecte d’artefacts disponible.

## Claude Code et Claude Design

Claude Code CLI et les fonctions Claude Design ne sont pas une seule capacité automatiquement disponible. L’architecture retient Claude Design comme candidat pour le design premium et les prototypes structurants, mais **ne déclare aucune fonction Design précise comme vérifiée sur le binaire installé**.

| Capacité | Statut avant test | Méthode de vérification | Statut attendu pour le routage |
|---|---|---|---|
| `process` / `stream` | `unsupported` | Smoke test de la commande cible, parsing du format observé et validation du mapping `ExecutionEvent` | `verified` uniquement pour la version et le node testés |
| `design` | `unsupported` | Exécuter un brief de référence avec la fonction native documentée sur cette version ; produire sources, preview, screenshots et parcours | `verified` seulement si une `PrototypeRelease` complète peut être produite sans supposition |
| `multimodal` | `unsupported` | Fournir une entrée non secrète par le mécanisme documenté de cette version et vérifier son utilisation effective | `verified` seulement avec preuve rattachée au run |
| `resume` / `export` | `unsupported` | Tests de continuité et de fichier décrits ci-dessus, sans inventer de commande | `verified` seulement après preuves de session et de manifest |

Un résultat de benchmark ne doit pas être généralisé à une autre version. L’absence d’une fonction Design vérifiée empêche seulement de router une capacité `design` requise ; elle n’empêche pas un run CLI dont les capacités requises sont vérifiées.

## Permissions, placement et fallback

L’option **`--dangerously-skip-permissions` est interdite dans l’architecture cible**. Le driver ne doit pas contourner les permissions du `RunSpec` par un mode global équivalent. Le run reste confiné au worktree, aux chemins et à l’egress autorisés ; les credentials et sessions restent dans leur environnement d’exécution.

Le `placement` et le `fallback_policy` sont appliqués par Temporal. Un node indisponible entraîne une attente ou le fallback explicite, jamais un changement implicite de driver. Une escalade vers Claude Design exige une capacité `design` vérifiée et autorisée, pas seulement la disponibilité du processus Claude Code.
