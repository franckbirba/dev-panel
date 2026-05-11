// DevPanel-flavored components — composed from shadcn primitives in
// ../ui/. This namespace is the only place project-specific composition
// lives; primitives stay generic so they can move to the catalogue at
// ui.devpanl.dev as-is.
export { StatusBadge } from "./StatusBadge";
export { WorkItemCard, type WorkItem } from "./WorkItemCard";
export { FleetRowCard, type FleetRow } from "./FleetRowCard";
export { RuntimeConsoleCard, type ConnectionState } from "./RuntimeConsoleCard";
export { CaptureCard, type Capture } from "./CaptureCard";
export { SprintProgressCard, type CycleProgress } from "./SprintProgressCard";
export { ProjectSwitcher, type Project } from "./ProjectSwitcher";
export { ConversationsList, type Thread } from "./ConversationsList";
export { ActiveAgentsRail, type ActiveAgent } from "./ActiveAgentsRail";
export { ContextBlock, type ProjectContext } from "./ContextBlock";
export {
  SettingsPanel,
  type StudioMember,
  type DevBot,
  type ProjectSettings,
} from "./SettingsPanel";
export {
  ProviderSwitcher,
  DEFAULT_PROVIDERS,
  type ProviderOption,
} from "./ProviderSwitcher";
export { StatusBar, type UsageSnapshot } from "./StatusBar";
export {
  DashboardThreadList,
  type DashboardThread,
} from "./DashboardThreadList";
export { AutoDecisionsPanel, type AutoDecision } from "./AutoDecisionsPanel";
export { MessageChips } from "./MessageChips";
export {
  SubjectConstellationCard,
  type Constellation,
  type ConstellationCenter,
  type ConstellationEdge,
} from "./SubjectConstellationCard";
// chat-renderer cards (DEVPA-218) — one per RendererPayload variant.
export { JobStatusCard } from "./JobStatusCard";
export { ConsoleStreamCard } from "./ConsoleStreamCard";
export { TerminalSessionCard } from "./TerminalSessionCard";
export { ErrorHaltCard } from "./ErrorHaltCard";
export { InlineActionsCard } from "./InlineActionsCard";
export { ReactCanvasCard } from "./ReactCanvasCard";
export { QueueCard } from "./QueueCard";
