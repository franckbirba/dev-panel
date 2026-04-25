import type { DevBotRow } from './loader.ts';

// Two rows describe "the same bot" iff (id, bot_token) match. A token rotation
// is observed as remove+add even though the id stays the same — desired,
// because we need to re-spawn the grammy Bot with the new token.
function key(b: DevBotRow): string {
  return `${b.id}:${b.bot_token}`;
}

export function diffBots(current: DevBotRow[], next: DevBotRow[]) {
  const curMap = new Map(current.map(b => [key(b), b]));
  const nextMap = new Map(next.map(b => [key(b), b]));
  const added: DevBotRow[] = [];
  const removed: DevBotRow[] = [];
  for (const [k, b] of nextMap) if (!curMap.has(k)) added.push(b);
  for (const [k, b] of curMap)  if (!nextMap.has(k)) removed.push(b);
  return { added, removed };
}

type Lifecycle = {
  start: (b: DevBotRow) => Promise<void>;
  stop:  (b: DevBotRow) => Promise<void>;
};

export class BotRegistry {
  private current: DevBotRow[] = [];
  constructor(private lifecycle: Lifecycle) {}

  async reconcile(next: DevBotRow[]): Promise<void> {
    const { added, removed } = diffBots(this.current, next);
    for (const b of removed) {
      try { await this.lifecycle.stop(b); }
      catch (err) { console.error(`[registry] stop ${b.bot_label} failed:`, err); }
    }
    // Drop removed bots immediately so subsequent reconciles don't double-stop.
    this.current = this.current.filter(b => !removed.some(r => key(r) === key(b)));
    for (const b of added) {
      try {
        await this.lifecycle.start(b);
        this.current.push(b);
      } catch (err) {
        console.error(`[registry] start ${b.bot_label} failed:`, err);
        // Intentionally do NOT push — next reconcile will retry.
      }
    }
  }

  snapshot(): DevBotRow[] {
    return [...this.current];
  }
}
