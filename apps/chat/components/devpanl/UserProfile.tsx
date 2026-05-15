"use client";

import { useEffect, useState } from "react";
import { LogOut, User } from "lucide-react";

type Me = {
  type: string;
  email: string | null;
  name: string;
  logout_url: string | null;
};

// Sidebar footer profile — identity surface for the chat. In prod the user
// arrives through Google SSO and traefik-forward-auth injects
// X-Forwarded-User; in local dev DASHBOARD_DEV_BYPASS_SSO=true mints a
// synthetic dev@localhost. Either way /api/me is the truth-source.
export function UserProfile() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("api/me", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Me) => {
        if (!cancelled) setMe(data);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message || "unknown");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) {
    return (
      <div className="flex items-center gap-2 rounded-[4px] border border-[var(--color-warning-border,var(--color-border-subtle))] bg-[var(--color-surface-container-low)] px-2 py-1.5">
        <User className="size-3.5 text-[var(--color-warning)]" />
        <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
          signed out
        </span>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="flex items-center gap-2 rounded-[4px] bg-[var(--color-surface-container-low)] px-2 py-1.5">
        <div className="size-5 animate-pulse rounded-full bg-[var(--color-surface-container)]" />
        <span className="font-mono text-[10px] text-[var(--color-foreground-faint)]">
          …
        </span>
      </div>
    );
  }

  const initial = (me.name || "?").charAt(0).toUpperCase();
  const isDev = me.email === "dev@localhost";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-[4px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-2 py-1.5 transition-colors hover:border-[var(--color-brand-border)] hover:bg-[var(--color-surface-container)]"
      >
        <div
          className={[
            "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
            isDev
              ? "bg-[var(--color-surface-container)] text-[var(--color-foreground-muted)]"
              : "bg-[var(--color-brand-soft)] text-[var(--color-brand)]",
          ].join(" ")}
        >
          {initial}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start text-left">
          <span className="truncate text-[11.5px] font-medium leading-tight text-[var(--color-foreground)]">
            {me.name}
          </span>
          <span className="truncate font-mono text-[9.5px] leading-tight text-[var(--color-foreground-faint)]">
            {me.email ?? me.type}
          </span>
        </div>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 right-0 mb-1 overflow-hidden rounded-[4px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] shadow-[0_4px_20px_rgba(0,0,0,0.4)]"
        >
          <div className="border-b border-[var(--color-border-subtle)] px-3 py-2">
            <div className="text-[11px] font-medium text-[var(--color-foreground)]">
              {me.name}
            </div>
            <div className="truncate font-mono text-[9.5px] text-[var(--color-foreground-faint)]">
              {me.email ?? "—"}
            </div>
            <div className="mt-1 inline-flex items-center gap-1 rounded-[3px] bg-[var(--color-surface-container-low)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--color-foreground-muted)]">
              {isDev ? "dev bypass" : me.type.replace(/_/g, " ")}
            </div>
          </div>
          {me.logout_url ? (
            <a
              href={me.logout_url}
              className="flex items-center gap-2 px-3 py-2 text-[11px] text-[var(--color-foreground-muted)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-foreground)]"
            >
              <LogOut className="size-3.5" />
              Sign out
            </a>
          ) : (
            <div className="px-3 py-2 text-[10.5px] text-[var(--color-foreground-faint)]">
              Local dev — no session to clear.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
