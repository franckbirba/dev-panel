import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { MessageChips } from "@/components/devpanl/MessageChips";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  Sparkles,
  User,
  Terminal,
  Cpu,
  Settings2,
} from "lucide-react";
import type { FC } from "react";

export const Thread: FC = () => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-[var(--color-background)]"
      style={{
        ["--thread-max-width" as string]: "50rem",
        ["--composer-radius" as string]: "12px",
        ["--composer-padding" as string]: "14px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="custom-scrollbar relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-6 pt-6">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <ThreadWelcome />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-12 flex flex-col gap-y-8 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mt-auto flex flex-col gap-3 overflow-visible bg-gradient-to-t from-[var(--color-background)] via-[var(--color-background)] to-transparent pb-5 pt-10">
            <ThreadScrollToBottom />
            <Composer />
            <ComposerFooterHints />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom absolute -top-4 z-10 self-center rounded-full border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] p-3 shadow-xl transition-all hover:scale-110 disabled:invisible"
      >
        <ArrowDownIcon className="size-4" />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root my-auto flex grow flex-col items-center justify-center py-10">
      <div className="flex flex-col items-center gap-5 text-center">
        <div className="relative">
          <div className="absolute -inset-6 rounded-full bg-[var(--color-brand)]/25 blur-3xl animate-pulse" />
          <div className="relative flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-container)] glow-primary">
            <Sparkles className="size-7 text-[var(--color-brand-foreground)]" />
          </div>
        </div>
        <div>
          <h1 className="font-headline text-[40px] font-bold leading-tight tracking-tight text-[var(--color-foreground)]">
            Flight Deck
          </h1>
          <p className="mt-2 max-w-md text-[15px] font-medium text-[var(--color-foreground-muted)]">
            System Ready. Orchestrate agents, audit fleet state, or query the
            studio knowledge base.
          </p>
        </div>
      </div>
      <div className="mt-10 w-full max-w-2xl">
        <ThreadSuggestions />
      </div>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions grid w-full @md:grid-cols-2 gap-2.5 pb-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 @md:nth-[n+5]:block nth-[n+5]:hidden animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion group h-auto w-full @md:flex-col items-start justify-start gap-1 rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-4 py-3 text-start transition-all hover:border-[var(--color-brand-border)] hover:bg-[var(--color-surface-container)] hover:glow-primary"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-brand)]" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-[12.5px] leading-snug text-[var(--color-foreground-muted)] empty:hidden group-hover:text-[var(--color-foreground)]" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="glass flex w-full flex-col gap-2 rounded-(--composer-radius) p-(--composer-padding) transition-all focus-within:border-[var(--color-brand-border)] focus-within:ring-1 focus-within:ring-[var(--color-brand)]/40 focus-within:glow-primary data-[dragging=true]:bg-[var(--color-brand-soft)]"
        >
          {/* Context chips row */}
          <div className="flex flex-wrap items-center gap-1.5 pb-1">
            <span className="tech-chip tech-chip-brand">
              <Cpu className="mr-1 inline-block size-2.5" />
              Qwen3-Coder
            </span>
            <span className="tech-chip">
              <Terminal className="mr-1 inline-block size-2.5" />
              dev@local
            </span>
            <span className="tech-chip">runtime: node</span>
            <span className="tech-chip">scope: studio</span>
          </div>

          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="System command, query, or directive…"
            className="aui-composer-input max-h-48 min-h-12 w-full resize-none bg-transparent px-1 py-1 font-sans text-[14px] leading-relaxed outline-none placeholder:text-[var(--color-foreground-faint)]"
            rows={1}
            autoFocus
            aria-label="Message input"
          />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between pt-1">
      <div className="flex items-center gap-1">
        <ComposerAddAttachment />
        <button
          type="button"
          aria-label="Tools"
          className="inline-flex size-7 items-center justify-center rounded-md text-[var(--color-foreground-muted)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-foreground)]"
        >
          <Settings2 className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Dispatch command (⌘↵)"
              side="top"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-9 rounded-[8px] bg-[var(--color-brand-container)] text-white shadow-[0_4px_12px_rgba(148,125,255,0.4)] transition-all hover:bg-[var(--color-brand)] hover:text-[var(--color-brand-foreground)] hover:scale-105 hover:shadow-[0_6px_18px_rgba(202,190,255,0.5)] active:scale-95"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-9 rounded-[8px] bg-[var(--color-error)] text-[var(--color-destructive-foreground)] shadow-[0_4px_12px_rgba(255,180,171,0.3)]"
              aria-label="Stop generating"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const ComposerFooterHints: FC = () => {
  return (
    <div className="flex items-center justify-between px-1 font-mono text-[10px] text-[var(--color-foreground-faint)]">
      <div className="flex items-center gap-2">
        <kbd className="hotkey">⌘ K</kbd>
        <span>for Quick Actions</span>
      </div>
      <div className="flex items-center gap-2">
        <kbd className="hotkey">⌘ ↵</kbd>
        <span>to dispatch</span>
        <span className="mx-1 opacity-40">·</span>
        <kbd className="hotkey">⇧ ↵</kbd>
        <span>newline</span>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-4 rounded-[8px] border border-[var(--color-error-soft)] bg-[var(--color-error-soft)]/30 p-4 font-mono text-[12px] text-[var(--color-error)]">
        <div className="flex items-start gap-3">
          <SquareIcon className="mt-0.5 size-3.5 shrink-0 fill-current" />
          <ErrorPrimitive.Message className="aui-message-error-message leading-relaxed" />
        </div>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantAvatar: FC = () => (
  <div className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-container)] text-[var(--color-brand-foreground)] shadow-[0_2px_8px_rgba(202,190,255,0.25)]">
    <Sparkles className="size-4" />
  </div>
);

const AssistantMessage: FC = () => {
  const ACTION_BAR_PT = "pt-2";
  const ACTION_BAR_HEIGHT = `-mb-8 min-h-8 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 relative flex animate-in gap-3 duration-150 [contain-intrinsic-size:auto_300px] [content-visibility:auto]"
    >
      <AssistantAvatar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Agent label + timestamp */}
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em]">
          <span className="font-bold text-[var(--color-brand)]">DevPanel</span>
          <span className="text-[var(--color-foreground-faint)] opacity-70">
            agent · streaming
          </span>
        </div>

        <div
          data-slot="aui_assistant-message-content"
          className="wrap-break-word text-[14px] leading-relaxed text-[var(--color-foreground)]"
        >
          <MessagePrimitive.GroupedParts
            groupBy={(part) => {
              if (part.type === "reasoning")
                return ["group-chainOfThought", "group-reasoning"];
              if (part.type === "tool-call")
                return ["group-chainOfThought", "group-tool"];
              return null;
            }}
          >
            {({ part, children }) => {
              switch (part.type) {
                case "group-chainOfThought":
                  return (
                    <div
                      data-slot="aui_chain-of-thought"
                      className="my-4 flex flex-col gap-3"
                    >
                      {children}
                    </div>
                  );
                case "group-reasoning": {
                  const running = part.status.type === "running";
                  return (
                    <ReasoningRoot defaultOpen={running}>
                      <ReasoningTrigger active={running} />
                      <ReasoningContent aria-busy={running}>
                        <ReasoningText className="font-mono text-[11.5px] leading-relaxed opacity-80">
                          {children}
                        </ReasoningText>
                      </ReasoningContent>
                    </ReasoningRoot>
                  );
                }
                case "group-tool":
                  return (
                    <ToolGroupRoot defaultOpen={true}>
                      <ToolGroupTrigger
                        count={part.indices.length}
                        active={part.status.type === "running"}
                      />
                      <ToolGroupContent>{children}</ToolGroupContent>
                    </ToolGroupRoot>
                  );
                case "text":
                  return <MarkdownText />;
                case "reasoning":
                  return <Reasoning {...part} />;
                case "tool-call":
                  return part.toolUI ?? <ToolFallback {...part} />;
                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
          <MessageError />
          <MessageChips />
        </div>

        <div
          data-slot="aui_assistant-message-footer"
          className={cn("flex items-center", ACTION_BAR_HEIGHT)}
        >
          <AssistantActionBar />
          <div className="ml-auto">
            <BranchPicker />
          </div>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root flex gap-1 opacity-40 transition-opacity hover:opacity-100"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" variant="ghost" className="size-7">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="size-3.5" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="size-3.5" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh" variant="ghost" className="size-7">
          <RefreshCwIcon className="size-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            variant="ghost"
            className="size-7 data-[state=open]:bg-[var(--color-surface-container)]"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          className="glass z-50 min-w-40 overflow-hidden rounded-[8px] p-1 shadow-2xl"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="flex cursor-pointer select-none items-center gap-2.5 rounded-[4px] px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-[var(--color-foreground-muted)] outline-none hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-brand)] focus:bg-[var(--color-brand-soft)]">
              <DownloadIcon className="size-3.5" />
              Export Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserAvatar: FC = () => (
  <div className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--color-surface-container-high)] text-[var(--color-foreground-muted)]">
    <User className="size-4" />
  </div>
);

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 flex animate-in flex-row-reverse items-start gap-3 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto]"
      data-role="user"
    >
      <UserAvatar />
      <div className="flex min-w-0 flex-1 flex-col items-end gap-1.5">
        <div className="mb-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-foreground-faint)]">
          <span>you</span>
        </div>
        <UserMessageAttachments />
        <div className="group relative max-w-[88%]">
          <div className="rounded-[12px] rounded-tr-[4px] bg-[var(--color-surface-container)] px-4 py-2.5 text-[14px] leading-relaxed text-[var(--color-foreground)] shadow-sm">
            <MessagePrimitive.Parts />
          </div>
          <div className="absolute -left-10 top-1/2 -translate-y-1/2 pe-2 opacity-0 transition-opacity group-hover:opacity-100">
            <UserActionBar />
          </div>
        </div>
        <BranchPicker />
      </div>
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton
          tooltip="Edit"
          variant="ghost"
          className="size-7 rounded-full hover:bg-[var(--color-surface-container)]"
        >
          <PencilIcon className="size-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col py-4"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root ms-auto flex w-full max-w-[88%] flex-col rounded-[12px] bg-[var(--color-surface-container)] shadow-xl">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-24 w-full resize-none bg-transparent p-4 text-[14px] leading-relaxed text-[var(--color-foreground)] outline-none"
          autoFocus
        />
        <div className="mx-3 mb-3 flex items-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-[6px] font-mono text-[10px] uppercase tracking-wider"
            >
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button
              size="sm"
              className="h-8 rounded-[6px] bg-[var(--color-brand-container)] px-4 font-mono text-[10px] uppercase tracking-widest text-white shadow-[0_4px_12px_rgba(148,125,255,0.35)] hover:bg-[var(--color-brand)] hover:text-[var(--color-brand-foreground)]"
            >
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-foreground-faint)]",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton
          tooltip="Previous"
          variant="ghost"
          className="size-6 p-0 hover:bg-transparent hover:text-[var(--color-foreground)]"
        >
          <ChevronLeftIcon className="size-3" />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-bold">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton
          tooltip="Next"
          variant="ghost"
          className="size-6 p-0 hover:bg-transparent hover:text-[var(--color-foreground)]"
        >
          <ChevronRightIcon className="size-3" />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
