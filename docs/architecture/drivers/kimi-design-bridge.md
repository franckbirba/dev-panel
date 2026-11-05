# KimiDesignBridge

`KimiDesignBridge` relie un export de **Kimi Design, dans l’application Kimi grand public**, à l’`ExperienceWorkflow`. Kimi Design et l’app Kimi sont distincts de **Kimi Code CLI** : les commandes, sessions et capacités de l’un ne sont jamais déduites de l’autre.

**Aucune CLI ou API publique documentée de Kimi Design n’est retenue dans cette architecture. Aucune automatisation GUI ne fait partie du chemin critique.** Une future API officielle pourra remplacer le bridge après une décision et des tests explicites, sans changer l’autorité Temporal.

Le bridge n’est pas un processus CLI de [`RunSpec`](../contracts/execution-run-spec.schema.json) et n’utilise pas les valeurs de driver réservées aux CLI. Il annonce uniquement une capacité `design.kimi-app` dans [`NodeRegistration`](../contracts/node-registration.schema.json) après vérification de la version de l’app, du node et du flux d’export.

## Flux normatif

```text
brief → app Kimi → export → artifact manifest → Temporal signal
```

1. **Brief** — DevPanel prépare un `DesignBrief` rattaché au `work_item_id`, à une spec versionnée, aux parcours, viewports, états et critères du quality gate. Le brief ne contient ni credential ni secret.
2. **App Kimi** — l’opérateur ou le mécanisme semi-automatisé autorisé utilise l’app sur le runner local. Aucune session ou credential local n’est transféré au cloud. Une action GUI expérimentale ne peut pas être une condition indispensable de production.
3. **Export** — le bridge reçoit ou détecte un export effectivement terminé. Il vérifie le format documenté par la version de l’app, la lisibilité du contenu, l’absence de secrets, la taille et le SHA-256. Une notification ou une capture d’écran ne prouve pas l’existence de l’export.
4. **Artifact manifest** — chaque export lourd est stocké dans MinIO/S3 et décrit par un [`ArtifactManifest`](../contracts/artifact-manifest.schema.json), normalement avec `kind = design-export`. Les sources légères destinées au projet sont versionnées dans Git avec une version et un SHA explicites.
5. **Temporal signal** — le bridge envoie `design_export_received` avec `run_id`, `artifact_ref` et SHA-256. Le workflow accepte le signal une seule fois pour le run et la révision courants, puis poursuit la création de la preview et la collecte des preuves.

Un signal dupliqué ou en retard ne crée pas un nouvel effet. La déduplication utilise au minimum `run_id`, `artifact_ref` et SHA-256. Un export invalide laisse le workflow dans son état d’attente ou suit sa politique d’échec ; il ne déclenche pas `prototype_released`.

## Capacités et vérification

| Élément | Statut avant test | Méthode de vérification | Statut attendu |
|---|---|---|---|
| Génération Kimi Design | `unsupported` | Exécuter un brief non secret dans la version installée de l’app et conserver les références de session non sensibles disponibles | `verified` uniquement sur cette version et ce node, sans extrapolation à Kimi Code |
| Export | `unsupported` | Produire un export complet, l’ouvrir, mesurer sa taille et calculer son SHA-256 | `verified` si le contenu est exploitable et le manifest valide |
| Reprise du workflow | `unsupported` | Mettre le workflow en attente, déposer l’export, envoyer le signal et vérifier la reprise sans worker occupé | `verified` si Temporal reprend une seule fois avec le bon artefact |
| Release de prototype | `unsupported` | Construire la preview et collecter screenshots, parcours, états et décisions | `verified` seulement si la `PrototypeRelease` complète est validée |

La reprise décrite ici est une reprise durable par Temporal après réception d’un artefact. Elle ne constitue pas une capacité `resume` de session CLI et ne présume pas qu’une session de l’app peut être reprise par programme.

## Conditions de release et preuves

L’export seul ne suffit pas. La [`PrototypeRelease`](../contracts/prototype-release.schema.json) exige notamment `source_location`, `source_sha`, `preview_url`, `design_system_sha`, des screenshots, des parcours, des états, des décisions et une date de création. Pour une source native, `source_format = native-design` ; pour du code produit et vérifié, `html` ou `react` selon le résultat réel.

Le Builder reçoit une version immuable et son `source_sha`, jamais « la dernière version » de l’app. Les screenshots et exports lourds restent dans MinIO/S3 avec leurs manifests ; les sources et décisions prévues pour Git y sont versionnées conformément à l’[ADR 0005](../adr/0005-git-versioned-product-artifacts.md).

## Placement et fallback

Le placement initial est `local`, car l’app et ses sessions résident sur le runner. Si le PC est absent, l’activité attend durablement selon `schedule_to_close` ; elle n’échoue pas immédiatement. À l’échéance, le workflow applique `wait` ou `escalate` selon sa politique. Un `cloud_fallback` n’est permis que si le work item l’autorise et si un autre driver possède exactement les capacités requises : il ne déplace pas l’app Kimi, sa session ou ses credentials vers le cloud.

Le fonctionnement détaillé des signaux, du quality gate et des fallbacks est défini par l’[`ExperienceWorkflow`](../workflows/experience-workflow.md).
