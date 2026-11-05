# Drivers d’exécution et de conception

Les drivers adaptent les processus CLI et les exports natifs aux contrats DevPanel. Ils ne déplacent aucune autorité : Temporal porte l’état technique durable, Plane l’état produit, Git les sources et décisions, et MinIO/S3 les artefacts lourds. Les règles normatives sont celles de l’[ADR 0003](../adr/0003-cli-only-agent-execution.md), de l’[ADR 0004](../adr/0004-hybrid-cloud-local-execution.md), du [`RunSpec`](../contracts/execution-run-spec.schema.json), des [`ExecutionEvent`](../contracts/execution-event.schema.json) et des [`NodeRegistration`](../contracts/node-registration.schema.json).

## Règle de capacité

**Les capacités sont testées par version. Une capacité non vérifiée vaut `unsupported`, jamais une supposition.** La présence d’une commande cible dans ces guides ne constitue donc pas, à elle seule, une attestation de compatibilité du binaire installé.

- `verified` exige une version exacte, un node, une date, une procédure et une preuve de résultat ; il est enregistré dans `NodeRegistration` avec le `placement` correspondant.
- `unsupported` est le statut par défaut, y compris lorsque le test n’a pas encore été exécuté. Il ne signifie pas nécessairement que le produit ne possède pas la fonction.
- `not_applicable` désigne une interface qui n’a pas de sens pour le composant, par exemple un flux JSON de processus pour un bridge d’export qui n’est pas un CLI.
- Une mise à jour du driver, un changement de node ou un changement de format de sortie invalide l’attestation concernée jusqu’à nouveau test.

Avant un test, l’opérateur consulte l’aide et les notes de version propres au binaire installé. Il vérifie que la commande et chaque option utilisées y sont documentées. Aucune option n’est copiée depuis un autre produit ou présumée à partir d’une documentation d’une autre version.

## Matrice commune

Les statuts ci-dessous sont les statuts par défaut avant enregistrement d’un test probant sur la version installée. Les politiques de fallback ne rendent jamais une capacité manquante interchangeable avec une autre.

| driver | process | stream | resume | export | design | placement | fallback |
|---|---|---|---|---|---|---|---|
| `claude-code-cli` | Cible : `claude -p "<prompt>" --output-format stream-json --verbose` ; `unsupported` avant smoke test | Cible : JSON streamé ; mapping `ExecutionEvent` `unsupported` avant test | `unsupported` ; aucune commande de reprise retenue ici | `unsupported` ; aucune commande d’export retenue ici | Claude Design est un candidat premium distinct du lancement CLI ; capacité `unsupported` avant test de la version | `cloud`, `local`, `preferred-local` ou `any`, selon le node testé | `wait`, `cloud_fallback`, `escalate` ou `deadline` selon le `RunSpec`, sans équivalence présumée |
| `kimi-code-cli` | Cible : `kimi -p "<prompt>" --output-format stream-json` ; `unsupported` avant smoke test | Cible : `stream-json` ; mapping `ExecutionEvent` `unsupported` avant test | Commande cible avec `--session` ; `unsupported` avant test de continuité | Commande cible `kimi export <native-session-id> --yes` ; `unsupported` avant validation du fichier | Prototypes HTML/React headless possibles comme cible ; capacité `unsupported` avant benchmark et preuves | `cloud`, `local`, `preferred-local` ou `any`, selon le node testé | Selon `fallback_policy` ; aucun transfert implicite des sessions ou credentials locaux |
| `kimi-design-bridge` | `not_applicable` : bridge local, pas un driver CLI de `RunSpec` | `not_applicable` : la reprise utilise un export, un `ArtifactManifest` et un signal Temporal | Reprise durable par Temporal après export ; pas une reprise de session CLI | Export depuis l’app Kimi ; `unsupported` tant que format, taille et SHA-256 ne sont pas validés | Kimi Design dans l’app Kimi grand public, semi-automatisé ; `unsupported` avant test de bout en bout | `local` pour l’app et ses sessions | `wait` puis `escalate` ; `cloud_fallback` seulement vers une capacité distincte explicitement autorisée et vérifiée |
| `opencode-cli` | Cible : `opencode run --format json` ; driver optionnel, `unsupported` avant smoke test | Sortie JSON cible ; flux temps réel et mapping `ExecutionEvent` `unsupported` avant test | `unsupported` ; aucune reprise native présumée | `unsupported` ; aucun export natif présumé | `unsupported` ; aucune équivalence avec Claude Design ou Kimi Design | `cloud`, `local`, `preferred-local` ou `any`, selon le node testé | Optionnel et soumis au `RunSpec` ; aucune équivalence avec les schedulers ou le design natifs de Kimi/Claude |

## Protocole minimal de vérification

Chaque test utilise un worktree isolé, des entrées non secrètes, des permissions minimales et un `RunSpec` valide lorsqu’un driver CLI est concerné. Le résultat consigne au minimum : driver et version exacte, node et système, date, commande effectivement documentée et testée, code de sortie, formats observés, identifiant de session natif non secret le cas échéant, artefacts et leurs SHA-256.

1. **Processus et stream** — démarrer un run court et vérifier le démarrage non interactif, le format réel de chaque sortie, la séquence des événements, le statut terminal et les heartbeats. Un code de sortie nul ne vaut pas preuve fonctionnelle. Les `ExecutionEvent` sont validés, ordonnés et expurgés ; les gros contenus sont externalisés par `artifact_ref`.
2. **Annulation** — demander `ExecutionAdapter.cancel(run_id)`, vérifier l’arrêt effectif du processus et conserver les preuves déjà produites. N’émettre `cancelled` qu’après l’arrêt constaté ; ne pas relancer le run et ne pas inventer une option CLI d’annulation.
3. **Reprise** — exécuter le mécanisme natif documenté sur la version installée, puis démontrer la continuité de la même session et l’émission de `resumed`. Sans cette preuve, Temporal choisit explicitement un nouveau run ou un arrêt, jamais une reprise implicite.
4. **Export** — ouvrir le résultat, valider son format et son absence de secrets, puis produire un `ArtifactManifest` avec taille et SHA-256. Un message annonçant un export sans fichier vérifiable reste `unsupported`.
5. **Design et multimodal** — utiliser un brief ou une image de test non secret, puis exiger les preuves propres au contrat : sources à SHA fixe, preview, screenshots et parcours pour un prototype ; utilisation observable de l’entrée pour le multimodal. Une réponse textuelle seule ne vérifie pas ces capacités.
6. **Cron et goal** — tester uniquement les mécanismes documentés par la version installée, sur une action locale sans effet externe. Un cron natif reste un rappel de session ; il ne remplace jamais Temporal et ne double jamais une programmation Temporal.

Seules les capacités `verified` peuvent apparaître dans `NodeRegistration.capabilities` ou satisfaire `RunSpec.required_capabilities`. Un fallback respecte `worktree.placement`, `execution_policy.fallback_policy`, le budget, les permissions et la sensibilité des données ; il ne change jamais silencieusement de driver ou de capacité.

## Guides

- [Claude Code CLI](claude-code-cli.md)
- [Kimi Code CLI](kimi-code-cli.md)
- [KimiDesignBridge](kimi-design-bridge.md)
- [OpenCode CLI](opencode-cli.md)

## Attestations

- [2026-11-03 — capacités Claude et Kimi](attestations/2026-11-03-cli-capabilities.md)
- [DEC-0001 — mutualisation du runner JSONL](../../work-items/DEVPA-252/decisions/DEC-0001-shared-cli-process-driver.yaml)
