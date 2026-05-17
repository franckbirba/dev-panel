// DevPanel-flavored components — composed from shadcn primitives in
// ../ui/. This namespace is the only place project-specific composition
// lives; primitives stay generic so they can move to the catalogue at
// ui.devpanl.dev as-is.

export { type ActiveAgent, ActiveAgentsRail } from "./ActiveAgentsRail";
export {
	type AffineDoc,
	AffineDocCard,
	type AffineDocContent,
	AffineDocListCard,
	AffineMutationCard,
	type AffineMutationResult,
} from "./AffineCards";
export { type AutoDecision, AutoDecisionsPanel } from "./AutoDecisionsPanel";
// MCP-tool cards (full surface parity).
export { CancelJobCard, type CancelJobResult } from "./CancelJobCard";
export { type Capture, CaptureCard } from "./CaptureCard";
export { ConsoleStreamCard } from "./ConsoleStreamCard";
export { ContextBlock, type ProjectContext } from "./ContextBlock";
export { ConversationsList, type Thread } from "./ConversationsList";
export {
	type DashboardThread,
	DashboardThreadList,
} from "./DashboardThreadList";
export { ErrorHaltCard } from "./ErrorHaltCard";
export { type FleetRow, FleetRowCard } from "./FleetRowCard";
export { FleetStatusSidebar } from "./FleetStatusSidebar";
export {
	type GitHubIssue,
	GitHubIssueCard,
	GitHubIssueListCard,
	type GitHubPR,
	GitHubPRCard,
	GitHubPRListCard,
} from "./GitHubCards";
export {
	type GlitchTipException,
	type GlitchTipFrame,
	type GlitchTipIssue,
	GlitchTipIssueCard,
	type GlitchTipLastEvent,
} from "./GlitchTipIssueCard";
export {
	GlitchTipResolutionCard,
	type GlitchTipResolutionResult,
} from "./GlitchTipResolutionCard";
export { InlineActionsCard } from "./InlineActionsCard";
// chat-renderer cards (DEVPA-218) — one per RendererPayload variant.
export { JobStatusCard } from "./JobStatusCard";
export { type MemoryRow, MemorySearchCard } from "./MemorySearchCard";
export {
	MemoryWriteCard,
	type MemoryWriteResult,
} from "./MemoryWriteCard";
export { MessageChips } from "./MessageChips";
export {
	AttachmentListCard,
	PageContentCard,
	PageListCard,
	PageMutationCard,
	type PageMutationResult,
	type PlaneAttachment,
	type PlanePage,
	type PlanePageContent,
} from "./PlanePagesCards";
export { type Project, ProjectSwitcher } from "./ProjectSwitcher";
export {
	DEFAULT_PROVIDERS,
	type ProviderOption,
	ProviderSwitcher,
} from "./ProviderSwitcher";
export { QueueCard } from "./QueueCard";
export { ReactCanvasCard } from "./ReactCanvasCard";
export { type ConnectionState, RuntimeConsoleCard } from "./RuntimeConsoleCard";
export {
	type DevBot,
	type ProjectSettings,
	SettingsPanel,
	type StudioMember,
} from "./SettingsPanel";
export { type CycleProgress, SprintProgressCard } from "./SprintProgressCard";
export { StatusBadge } from "./StatusBadge";
export { StatusBar, type UsageSnapshot } from "./StatusBar";
export {
	type Constellation,
	type ConstellationCenter,
	type ConstellationEdge,
	SubjectConstellationCard,
} from "./SubjectConstellationCard";
export { TerminalSessionCard } from "./TerminalSessionCard";
export { TranscriptCard, type TranscriptRow } from "./TranscriptCard";
export {
	WorkflowDispatchCard,
	type WorkflowDispatchResult,
	type WorkflowInstance,
	WorkflowInstancesCard,
} from "./WorkflowCards";
export { type WorkItem, WorkItemCard } from "./WorkItemCard";
export { WorkbenchEngine } from "./WorkbenchEngine";
export { WorkbenchLogs } from "./WorkbenchLogs";
export { WorkbenchShell } from "./WorkbenchShell";
export { CommandPalette } from "./CommandPalette";
export { type WorkbenchView } from "./DashboardThreadList";
export { UserProfile } from "./UserProfile";
