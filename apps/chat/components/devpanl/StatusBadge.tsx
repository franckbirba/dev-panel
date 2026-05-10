import { Badge } from "@/components/ui/badge";

// Maps the status strings the worker, plane, and webhooks emit onto the
// 6 visual tones the design system defines. Adding a new status here is
// the only place it should be added — every card that shows status
// imports StatusBadge instead of mapping tones inline.
const STATUS_TONE = {
  // Plane work-item states
  backlog:    "neutral",
  todo:       "info",
  in_progress:"info",
  review:     "warning",
  done:       "success",
  cancelled:  "neutral",
  // BullMQ job states
  active:     "info",
  completed:  "success",
  failed:     "error",
  blocked:    "warning",
  delayed:    "neutral",
  waiting:    "neutral",
  // Capture states
  new:        "brand",
  triaging:   "info",
  promoted:   "success",
  dropped:    "neutral",
  // Deploy states
  pending:    "neutral",
  succeeded:  "success",
  rolled_back:"warning",
} as const;

type Status = keyof typeof STATUS_TONE;

export function StatusBadge({ status }: { status: Status | string }) {
  const tone = (STATUS_TONE as Record<string, "neutral" | "success" | "warning" | "error" | "info" | "brand">)[status] ?? "neutral";
  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}
