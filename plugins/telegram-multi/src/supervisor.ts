/**
 * Supervisor utilities for grammy Bot polling.
 *
 * The actual supervisor wiring lives in server.ts because it touches the
 * grammy Bot instance and the running map. This file holds pure helpers
 * that can be unit-tested without booting the MCP transport.
 */

/**
 * Delay before the Nth restart attempt (0-based).
 *
 * Sequence: 2s, 4s, 8s, 16s, 32s, 60s, 60s, ... (capped at 60s).
 *
 * Cap chosen so a transient 409 Conflict recovers within one watchdog tick
 * (the watchdog runs every 60s). Lower bound chosen so a flapping token
 * doesn't burn CPU re-creating long-poll connections faster than Telegram
 * can reset them.
 */
export function pollRetryDelayMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
}
