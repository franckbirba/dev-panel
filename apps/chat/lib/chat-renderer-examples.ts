// Reference payloads — one per RendererPayload variant. Used by the
// stories (so the gallery shows real data) and as the "checked into the
// repo, validated against the schema" deliverable in DEVPA-218. Each
// example passes parseRendererPayload(); tests in
// __tests__/chat-renderer-examples.test.ts enforce that.

import type {
  JobStatusPayload,
  ConsoleStreamPayload,
  TerminalSessionPayload,
  ErrorHaltPayload,
  InlineActionsPayload,
  ReactCanvasPayload,
  QueueCardPayload,
  RendererPayload,
} from "./chat-renderer-types";

export const JOB_STATUS_EXAMPLE: JobStatusPayload = {
  type: "job-status",
  job_id: "job_zeno_42_builder",
  name: "Schema_Builder_v4",
  state: "running",
  progress: 72,
  detail: "Compiling 3 of 5 modules…",
  updated_at: "2026-05-11T02:18:30Z",
};

export const CONSOLE_STREAM_EXAMPLE: ConsoleStreamPayload = {
  type: "console-stream",
  title: "Dependency_Graph_Sync",
  state: "connected",
  lines: [
    {
      ts: "2026-05-11T02:18:32Z",
      severity: "info",
      text: "Loading dependency graph from cache",
    },
    {
      ts: "2026-05-11T02:18:32Z",
      severity: "trace",
      text: "graph nodes: 1284, edges: 4221",
    },
    {
      ts: "2026-05-11T02:18:33Z",
      severity: "sync",
      text: "Syncing with remote tracker",
    },
    {
      ts: "2026-05-11T02:18:34Z",
      severity: "warn",
      text: "Stale checksum on devpanel/widget-bundle",
    },
    {
      ts: "2026-05-11T02:18:35Z",
      severity: "info",
      text: "SUCCESS — graph rebuilt in 2840ms",
    },
  ],
};

export const TERMINAL_SESSION_EXAMPLE: TerminalSessionPayload = {
  type: "terminal-session",
  session_id: "ssh_hetzner_882",
  host: "hetzner-vps",
  user: "deploy",
  prompt: "deploy@hetzner:~",
  initial_lines: [
    "Connected to hetzner-vps (62.238.0.167)",
    "Last login: Mon May 11 02:18:00 2026 from 10.0.0.2",
    "$ systemctl status shelly.service",
    "● shelly.service - Shelly orchestration agent",
    "     Loaded: loaded (/etc/systemd/system/shelly.service; enabled)",
    "     Active: active (running) since Sun 2026-05-10 22:13:11 UTC",
  ],
  metrics: {
    load: [0.42, 0.31, 0.27],
    memory_used: "5.8 GiB",
    memory_total: "15.6 GiB",
  },
  security: [
    { label: "sudo: bounded", variant: "ok" },
    { label: "proxy: direct", variant: "warn" },
  ],
};

export const ERROR_HALT_EXAMPLE: ErrorHaltPayload = {
  type: "error-halt",
  error_code: "ENV_SECRET_MISSING",
  message: "Missing GITHUB_TOKEN — cannot push branch feat/devpa-218-x.",
  source: "merge-coordinator",
  recovery_prompt:
    "Provide a fresh PAT or skip the push and let CI pick the commit up later?",
  actions: [
    { id: "inject_pat", label: "Inject PAT", variant: "primary" },
    { id: "skip_push", label: "Skip push" },
    { id: "abort", label: "Abort", variant: "danger" },
  ],
};

export const INLINE_ACTIONS_EXAMPLE: InlineActionsPayload = {
  type: "inline-actions",
  prompt: "How should I proceed?",
  actions: [
    { id: "allow_sudo", label: "Allow sudo", variant: "primary" },
    { id: "check_proxy", label: "Check proxy" },
    { id: "apply_theme", label: "Apply theme" },
    { id: "export_react", label: "Export React" },
  ],
};

export const REACT_CANVAS_EXAMPLE: ReactCanvasPayload = {
  type: "react-canvas",
  filename: "DependencyExplorer.tsx",
  tsx: `import { useState } from "react";
export default function DependencyExplorer() {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ padding: 12, background: hover ? "#222" : "#fff" }}
    >
      {hover ? "Boo!" : "Hover me"}
    </button>
  );
}`,
  deps: ["react"],
  theme: ["--color-card", "--color-foreground"],
  slots: [
    { kind: "meta", title: "Hover Handler", body: "useState(false) → toggles bg" },
    { kind: "meta", title: "Spring Physics", body: "(none — out of scope)" },
    { kind: "meta", title: "Theme Tokens", body: "--color-card, --color-foreground" },
  ],
  bundle_size: 1240,
};

export const QUEUE_CARD_EXAMPLE: QueueCardPayload = {
  type: "queue-card",
  title: "ENV INJECTION QUEUE",
  items: [
    {
      id: "env_zeno_db_pass",
      label: "ZENO_DB_PASSWORD",
      state: "waiting_for_input",
      detail: "Required by builder job_zeno_42",
      actions: [
        { id: "supply_env_zeno_db_pass", label: "Supply", variant: "primary" },
        { id: "skip_env_zeno_db_pass", label: "Skip" },
      ],
    },
    {
      id: "env_glitchtip_token",
      label: "GLITCHTIP_API_TOKEN",
      state: "approved",
      detail: "Injected at 02:14",
    },
    {
      id: "env_openai_key",
      label: "OPENAI_API_KEY",
      state: "expired",
      detail: "TTL elapsed — re-inject before next run",
    },
  ],
  footer: "3 pending, 1 expired",
};

export const ALL_RENDERER_EXAMPLES: RendererPayload[] = [
  JOB_STATUS_EXAMPLE,
  CONSOLE_STREAM_EXAMPLE,
  TERMINAL_SESSION_EXAMPLE,
  ERROR_HALT_EXAMPLE,
  INLINE_ACTIONS_EXAMPLE,
  REACT_CANVAS_EXAMPLE,
  QUEUE_CARD_EXAMPLE,
];
