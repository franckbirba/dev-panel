"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] render error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-background)] p-6 text-center">
      <h2 className="text-[15px] font-semibold text-[var(--color-foreground)]">
        Something rendered wrong.
      </h2>
      <p className="max-w-md font-mono text-[11px] text-[var(--color-foreground-muted)]">
        {error.message || "Unknown error"}
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-1.5 text-[12px] hover:bg-[var(--color-surface-3)]"
      >
        Retry
      </button>
    </div>
  );
}
