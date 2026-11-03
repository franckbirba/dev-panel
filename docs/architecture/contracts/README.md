# Contrats DevPanel

Ces contrats normalisent les entrées et les événements des drivers CLI derrière `ExecutionAdapter`, les releases de prototypes, les décisions, les artefacts de preuve et l’enregistrement des nodes. Ils ne déplacent pas les autorités définies par les ADR : Temporal conserve l’état technique, Plane l’état produit, Git les sources et décisions, et MinIO/S3 les fichiers lourds.

## Règles communes

- Les schémas utilisent **JSON Schema draft 2020-12**, déclaré par `$schema`.
- Les objets racines et les objets imbriqués sont fermés avec `additionalProperties: false`. Un consommateur doit rejeter les champs inconnus plutôt que les ignorer silencieusement.
- Les identifiants de contrat sont des chaînes contenant un **UUID canonique** ou un **ULID Crockford majuscule de 26 caractères**. Les PID système ne sont pas des identifiants de contrat.
- Les timestamps sont des chaînes **RFC 3339** portant `format: date-time`, avec `Z` ou un offset explicite. Le validateur JSON Schema doit activer la validation des formats.
- Chaque contrat porte `schema_version` au format **`MAJOR.MINOR`**, par exemple `1.0`.
- L’ajout d’un champ optionnel entraîne un **changement mineur**. La suppression d’un champ ou le changement de son type entraîne un **changement majeur**.
- Les URI ne contiennent ni credential ni URL présignée. Les fichiers lourds sont stockés hors des contrats et représentés par un `artifact_ref` immuable accompagné, lorsque le contenu est produit, de sa taille et de son SHA-256.

Schémas disponibles :

- [RunSpec](execution-run-spec.schema.json) : entrée complète d’un run CLI ;
- [ExecutionEvent](execution-event.schema.json) : événement ordonné dont la forme de `payload` dépend de `type` ;
- [PrototypeRelease](prototype-release.schema.json) : version immuable d’un prototype et de ses preuves visuelles ;
- [DecisionRecord](decision-record.schema.json) : décision versionnée avec options, choix et justification ;
- [ArtifactManifest](artifact-manifest.schema.json) : descripteur vérifiable d’un artefact externalisé ;
- [NodeRegistration](node-registration.schema.json) : capacités vérifiées et disponibilité d’un node.

## RunSpec

`RunSpec` fixe le work item Plane, le run Temporal, l’étape de delivery, le commit et le worktree, le driver et ses capacités vérifiées, les entrées immuables, les permissions, la politique d’exécution et les preuves attendues. Le driver ne peut pas compléter ces informations par des valeurs implicites.

Les valeurs de `fallback_policy` sont `wait`, `cloud_fallback`, `escalate` et `deadline`. Les classes d’autonomie `R0` à `R3` renvoient à la politique de sécurité ; elles ne constituent pas une autorisation à outrepasser `permissions`.

### Exemple complet — build avec Kimi Code CLI

L’exemple utilise une branche dédiée, deux artefacts d’entrée et deux critères d’acceptation. Les références Git sont ancrées sur un commit et les empreintes SHA-256 portent sur le contenu adressé.

```json
{
  "schema_version": "1.0",
  "run_id": "2d4f2a15-2f58-4f65-9f3e-2de61a4f5a20",
  "workflow_run_id": "7efcf46f-2ddc-4a04-a2f2-867fd2bb8f61",
  "work_item_id": "80f2f4cf-2a76-43f2-9a07-bb9a2f16f7fd",
  "stage": "build",
  "repository": {
    "name": "franckbirba/dev-panel",
    "url": "https://github.com/franckbirba/dev-panel.git"
  },
  "base_sha": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  "branch": "agent/DP-123-build",
  "worktree": {
    "path": "/worktrees/DP-123-build",
    "placement": "preferred-local"
  },
  "driver": "kimi-code-cli",
  "required_capabilities": [
    "resume",
    "permissions"
  ],
  "input_artifacts": [
    {
      "artifact_ref": "https://github.com/franckbirba/dev-panel/blob/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/docs/work-items/DP-123/spec.md",
      "mime_type": "text/markdown",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    {
      "artifact_ref": "https://github.com/franckbirba/dev-panel/blob/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/prototypes/DP-123/index.html",
      "mime_type": "text/html",
      "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
  ],
  "permissions": {
    "allowed_tools": [
      "shell",
      "read",
      "edit",
      "search"
    ],
    "read_paths": [
      "/worktrees/DP-123-build"
    ],
    "write_paths": [
      "/worktrees/DP-123-build"
    ],
    "network_egress": [
      "github.com",
      "api.github.com"
    ]
  },
  "execution_policy": {
    "max_duration_seconds": 2700,
    "max_cost": {
      "amount": 5.0,
      "currency": "USD"
    },
    "fallback_policy": "wait",
    "autonomy_class": "R1"
  },
  "output_contract": {
    "required_artifacts": [
      {
        "name": "verification-report",
        "kind": "test-report",
        "mime_type": "application/json"
      },
      {
        "name": "kimi-session",
        "kind": "session-export",
        "mime_type": "application/json"
      }
    ],
    "acceptance_criteria": [
      "Les tests unitaires et d’intégration requis par la spec passent dans le worktree.",
      "Le rapport de vérification et l’export de session sont rattachés au run et vérifiables par SHA-256."
    ]
  }
}
```

## ExecutionEvent

`sequence` est un entier supérieur ou égal à `1`, strictement croissant dans un run. `event_id` assure l’idempotence de l’ingestion. Le `type` choisit un schéma de `payload` fermé : un champ arbitraire n’est pas accepté.

**Les secrets sont interdits dans `payload`.** Le producteur doit expurger tokens, mots de passe, cookies, credentials, variables d’environnement sensibles et contenus équivalents avant l’émission. Cette règle porte aussi sur les extraits `stdout`, `stderr`, les résumés d’outils et les messages d’erreur. Un schéma JSON ne peut pas reconnaître toutes les formes de secrets : le filtrage à la source et les contrôles de sécurité restent obligatoires.

Les données volumineuses ne sont pas intégrées au flux. Elles sont remplacées par un `artifact_ref` vers MinIO/S3 ou tout stockage d’artefacts autorisé. Pour `stdout` et `stderr`, un contenu tronqué exige cette référence ; les entrées et sorties d’outils disposent également de références externalisées.

### Exemple complet — création d’un artefact

```json
{
  "schema_version": "1.0",
  "event_id": "be61e7dc-1a2f-43a2-a338-e19e942170f5",
  "run_id": "2d4f2a15-2f58-4f65-9f3e-2de61a4f5a20",
  "sequence": 7,
  "timestamp": "2026-11-02T14:35:12Z",
  "type": "artifact_created",
  "payload": {
    "artifact_ref": "s3://devpanel-artifacts/runs/2d4f2a15-2f58-4f65-9f3e-2de61a4f5a20/verification-report.json",
    "kind": "test-report",
    "mime_type": "application/json",
    "size_bytes": 48213,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
}
```

## PrototypeRelease

`PrototypeRelease` désigne une version précise du prototype, ancrée sur ses sources et sur le design system utilisé. Les captures sont externalisées et vérifiables par SHA-256 ; leurs dimensions sont exprimées en pixels CSS. `supported_states` contient au moins un état parmi `empty`, `loading`, `error` et `success`, et chaque `decision_refs` renvoie à un `DecisionRecord`.

### Exemple complet — release d’un prototype React

```json
{
  "schema_version": "1.0",
  "prototype_id": "c45a5e67-0f62-4d3f-a3af-77b20de87c01",
  "work_item_id": "80f2f4cf-2a76-43f2-9a07-bb9a2f16f7fd",
  "prototype_version": "1.0.0",
  "source_format": "react",
  "source_location": "https://github.com/franckbirba/dev-panel/tree/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/prototypes/DP-123",
  "source_sha": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  "preview_url": "https://preview.devpanel.local/prototypes/DP-123/1.0.0",
  "design_system_sha": "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1",
  "screenshots": [
    {
      "artifact_ref": "s3://devpanel-artifacts/prototypes/DP-123/1.0.0/desktop-success.png",
      "viewport": {
        "width": 1440,
        "height": 900
      },
      "state": "success",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "artifact_ref": "s3://devpanel-artifacts/prototypes/DP-123/1.0.0/mobile-error.png",
      "viewport": {
        "width": 390,
        "height": 844
      },
      "state": "error",
      "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
  ],
  "user_flows": [
    "Consulter le détail d’un work item et ses preuves.",
    "Reprendre une exécution après une décision humaine."
  ],
  "supported_states": [
    "empty",
    "loading",
    "error",
    "success"
  ],
  "decision_refs": [
    "f5e6265f-c49a-4e2a-b7a8-f9efee73a01b"
  ],
  "native_session_ids": [
    "a2b45b15-e899-4e77-9d42-cb25733a5f20"
  ],
  "created_by": "kimi-code-cli",
  "created_at": "2026-11-02T15:05:00Z"
}
```

## DecisionRecord

`DecisionRecord` conserve le contexte, les options étudiées, le choix et ses conséquences. `chosen_option` doit reprendre l’identifiant d’une entrée de `options` ; ce lien logique est vérifié par le consommateur. Le champ optionnel `supersedes` référence la décision remplacée sans effacer l’historique.

### Exemple complet — choix du format de prototype

```json
{
  "schema_version": "1.0",
  "decision_id": "f5e6265f-c49a-4e2a-b7a8-f9efee73a01b",
  "work_item_id": "80f2f4cf-2a76-43f2-9a07-bb9a2f16f7fd",
  "status": "accepted",
  "context": "Le work item DP-123 exige un prototype responsive réutilisant les composants et les tokens réels du projet avant le build.",
  "options": [
    {
      "id": "react-prototype",
      "description": "Produire un prototype React avec les composants et tokens du dépôt."
    },
    {
      "id": "static-html",
      "description": "Produire une maquette HTML autonome sans dépendance au design system applicatif."
    }
  ],
  "chosen_option": "react-prototype",
  "rationale": "Le prototype React réduit l’écart entre la conception et l’implémentation tout en rendant les états et les parcours directement testables.",
  "consequences": [
    "Le Builder doit utiliser exactement source_sha et design_system_sha de la PrototypeRelease.",
    "Les prototypes autonomes devront être adaptés avant de rejoindre l’application."
  ],
  "references": [
    "https://github.com/franckbirba/dev-panel/blob/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/docs/work-items/DP-123/spec.md",
    "https://github.com/franckbirba/dev-panel/tree/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/prototypes/DP-123"
  ],
  "author": {
    "type": "agent",
    "driver": "kimi-code-cli",
    "native_session_id": "a2b45b15-e899-4e77-9d42-cb25733a5f20"
  },
  "supersedes": "1c9a80dd-37b6-45b7-b24f-83308af65f90",
  "created_at": "2026-11-02T15:00:00Z"
}
```

## ArtifactManifest

`ArtifactManifest` identifie le contenu produit par un run et son stockage externe. Le consommateur vérifie `size_bytes` et `sha256` avant d’utiliser l’artefact comme preuve ; l’URI ne doit contenir ni credential ni paramètres de signature temporaire.

### Exemple complet — rapport de vérification

```json
{
  "schema_version": "1.0",
  "artifact_id": "40f6ef9c-f262-46b6-a55b-26c26420de62",
  "run_id": "2d4f2a15-2f58-4f65-9f3e-2de61a4f5a20",
  "kind": "test-report",
  "uri": "s3://devpanel-artifacts/runs/2d4f2a15-2f58-4f65-9f3e-2de61a4f5a20/verification-report.json",
  "mime_type": "application/json",
  "size_bytes": 48213,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "created_at": "2026-11-02T14:35:12Z"
}
```

## NodeRegistration

`NodeRegistration` annonce uniquement les capacités vérifiées sur les versions installées. Le placement suit les valeurs `local`, `cloud`, `preferred-local` et `any` ; `last_heartbeat_at` permet au control plane de distinguer une capacité disponible d’un node injoignable.

### Exemple complet — runner local avec design natif

```json
{
  "schema_version": "1.0",
  "node_id": "7b53ad07-b94e-4af0-a969-c6a22a0ec73b",
  "hostname": "macbook-franck.local",
  "capabilities": [
    {
      "name": "cli.kimi-code",
      "driver": "kimi-code-cli",
      "version": "1.2.0",
      "placement": "local"
    },
    {
      "name": "design.kimi-app",
      "driver": "kimi-design-bridge",
      "version": "2026.11.0",
      "placement": "local"
    }
  ],
  "status": "online",
  "started_at": "2026-11-02T08:00:00Z",
  "last_heartbeat_at": "2026-11-02T15:06:30Z"
}
```
