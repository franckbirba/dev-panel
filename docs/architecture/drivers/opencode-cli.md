# OpenCode CLI

`OpenCodeCliDriver` est un driver **optionnel**, jamais une dépendance centrale. Il suit le même contrat `ExecutionAdapter` que les autres processus CLI et reçoit un [`RunSpec`](../contracts/execution-run-spec.schema.json) valide. DevPanel ne déduit aucune capacité d’OpenCode de celles de Claude Code ou de Kimi Code.

## Lancement et sortie JSON

La commande cible retenue est :

```bash
opencode run --format json
```

Avant utilisation, l’opérateur vérifie cette invocation dans l’aide de la version installée et réalise un smoke test avec les entrées et permissions du run. Aucune option supplémentaire n’est inventée dans ce guide. Le caractère optionnel du driver signifie qu’un workflow ne doit pas exiger sa présence sauf si le `RunSpec` le sélectionne explicitement et si le node annonce les capacités vérifiées.

Le format `json` ne prouve pas à lui seul un streaming temps réel, un événement par ligne ou une compatibilité avec `stream-json`. Le test de version doit observer le format, le moment d’émission des données, les erreurs et la terminaison, puis définir le mapping réel vers [`ExecutionEvent`](../contracts/execution-event.schema.json). Tant que ce mapping n’est pas démontré, `stream` vaut `unsupported`.

Les événements normalisés respectent les mêmes règles que pour les autres drivers : séquence strictement croissante, `event_id` idempotent, secrets exclus et données volumineuses externalisées par `artifact_ref`. Le statut terminal du processus ne remplace pas les artefacts et critères d’acceptation.

## Annulation, reprise et export

L’annulation agit sur le processus possédé par le worker : demande d’arrêt, vérification de la terminaison, collecte des preuves disponibles, puis événement `cancelled`. Aucune option native d’annulation n’est supposée.

`resume` et `export` restent `unsupported` tant qu’un mécanisme documenté sur la version installée n’a pas été testé. Une reprise valide doit démontrer la continuité de session et produire `resumed`. Un export valide doit être lisible, expurgé et couvert par un [`ArtifactManifest`](../contracts/artifact-manifest.schema.json) avec taille et SHA-256. Aucune commande de reprise ou d’export n’est reprise de Kimi ou Claude.

## Absence d’équivalence native présumée

OpenCode ne garantit **aucune équivalence avec les schedulers ou le design natifs de Kimi ou Claude**. En particulier :

- `cron` et tout scheduling natif sont `unsupported` sans test propre à OpenCode ; dans tous les cas, Temporal reste l’autorité durable et aucun cron natif ne double une programmation Temporal ;
- `goal`, `multimodal`, `resume` et `export` sont `unsupported` sans preuves propres au driver et à sa version ;
- `design` est `unsupported` sans benchmark produisant sources, preview, screenshots, parcours et `PrototypeRelease` ; un résultat de code ou de texte ne suffit pas ;
- la disponibilité d’un modèle derrière OpenCode ne démontre ni une capacité de l’outil, ni une qualité équivalente, ni une parité de coût ou de permissions.

Pour vérifier une capacité, l’opérateur utilise uniquement le mécanisme documenté par la version installée, enregistre la commande réellement testée et rattache les preuves au run. Le statut `verified` reste limité au couple version/node dans [`NodeRegistration`](../contracts/node-registration.schema.json).

## Placement, fallback et sécurité

Le routage respecte `worktree.placement` et `execution_policy.fallback_policy`. OpenCode peut être placé sur un node cloud ou local seulement après vérification des capacités requises. Un fallback depuis ou vers OpenCode exige une politique explicite, les mêmes capacités vérifiées, un budget compatible et les permissions nécessaires ; il ne constitue pas une escalade automatique vers Claude ou Kimi.

Le processus reste confiné au worktree, aux chemins et à l’egress autorisés par le `RunSpec`. Les credentials et sessions ne sont pas transférés entre nodes. L’absence du PC laisse une activité locale en attente durable ou suit le fallback autorisé, sans échec immédiat ni duplication d’effets externes.
