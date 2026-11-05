# Attestations CLI — 2026-11-03

Ces attestations sont limitées au node `192.168.1.9` et aux versions/procédures citées. Elles ne sont pas généralisables à d’autres nodes ou versions. Les tests mockés vérifient le contrat logiciel, mais ne remplacent pas une exécution réelle lorsque la capacité exige une session fournisseur.

## Kimi Code CLI 2.3.3

| Capacité | Statut | Preuve |
|---|---|---|
| `process` | `verified` | Kimi Code CLI 2.3.3 démarré réellement avec `kimi -p … --output-format stream-json`, statut `completed` |
| `stream` | `verified` | Événements réels `started`, `stdout`, `artifact_created`, `completed` et session native `session_d2f1c215-7305-4be7-81a5-5bfe2592c7bd` |
| `cancel` | `verified` | Test de contrat : `cancelled` émis uniquement après le `close` du processus |
| `export` | `verified` | Journal `events.jsonl` réel, avec taille et SHA-256 rattachés à `artifact_created` et `completed` |
| `resume` | `verified` | Reprise réelle de `session_d2f1c215-7305-4be7-81a5-5bfe2592c7bd` dans son répertoire d’origine, avec `REPRISE_OK` et artefact. Kimi exige le répertoire de création de la session ; une autre directory est refusée |
| `design` | `unsupported` | Aucun benchmark de prototype réel exécuté |
| `cron` | `unsupported` | Rappels natifs présents, mais non testés comme capacité durable de production |
| `goal` | `unsupported` | Aucun objectif natif réel exécuté pour cette attestation |
| `multimodal` | `unsupported` | Aucune entrée image réelle testée |

Commits de preuve :

- `7a033a22fc91ebc089244bb185090be2f4445c86`
- `a8ad6c213863073bf1ce41aa9063a0822ebc3ee3`

Tests de contrat : **35/35 réussis** pour OpenCode, Claude, Kimi, l’intégration et l’expurgation.

## Claude Code CLI

| Capacité | Statut | Preuve |
|---|---|---|
| `process` | `unsupported` | Le processus démarre, mais la session OAuth expire avant un run complet |
| `stream` | `unsupported` | Le message `OAuth session expired and could not be refreshed` empêche la validation du flux complet |
| `cancel` | `verified` | Test de contrat : `cancelled` émis uniquement après le `close` du processus |
| `export` | `verified` | Le runner produit le journal et son SHA-256 dans les tests de contrat |
| `resume` | `unsupported` | Continuité de session non démontrée |
| `design` | `unsupported` | Aucun prototype réel exécuté |
| `multimodal` | `unsupported` | Aucune entrée image réelle testée |

Le blocage OAuth est environnemental et doit être résolu avant de modifier les statuts `process` et `stream`. Aucun contournement de permission n’est appliqué.

## OpenCode 2.1.4

| Capacité | Statut | Preuve |
|---|---|---|
| `process` | `verified` | `opencode run` réel avec réponse `OK`, statut `completed` |
| `stream` | `verified` | Événements réels `started`, `stdout`, `artifact_created`, `completed` |
| `cancel` | `verified` | Test de contrat : `cancelled` émis uniquement après le `close` du processus |
| `export` | `verified` | Journal réel, avec taille et SHA-256 rattachés à `artifact_created` et `completed` |
| `resume` | `verified` | Reprise réelle de `ses_e5dca331bffeRkr24o1EqFmadC`, réponse `REPRISE_OK`, nouvelle session native `ses_e5d930df2ffeJ7Nb1a2A1tvpuu` et artefact SHA-256 |
| `design` | `unsupported` | Aucun benchmark de prototype réel exécuté |
| `cron` | `unsupported` | Aucune capacité de scheduling durable validée |
| `multimodal` | `unsupported` | Aucune entrée image réelle testée |

Commit de preuve : `269070a0776db0cceac4b08f50c275fe817a85f9`.

Vérification complémentaire du 2026-11-05 sur OpenCode 2.1.4 : le run réel `pwd` émet `tool_use` avec `part.state.input`, `part.state.output` et `part.state.status=completed`, sans `tool_result` séparé. Le driver normalise et déduplique ces snapshots ; l’état d’erreur est couvert par une fixture de contrat, pas présenté comme une observation réelle. Un smoke du driver a validé un premier run `completed` puis une reprise réelle avec `--session`, également `completed`. Les 42 tests ciblés des drivers, de l’expurgation et du timeout passent.

## Références

- `src/worker/cli-process-driver.js`
- `src/worker/claude-code-cli-driver.js`
- `src/worker/kimi-code-cli-driver.js`
- `src/worker/opencode-cli-driver.js`
- `src/worker/redact-text.js`
- `tests/worker/claude-code-cli-driver.test.js`
- `tests/worker/kimi-code-cli-driver.test.js`
- `tests/worker/opencode-cli-driver.test.js`
- `tests/worker/redact-text.test.js`
- `docs/work-items/DEVPA-252/decisions/DEC-0001-shared-cli-process-driver.yaml`
