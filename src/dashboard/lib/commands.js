// src/dashboard/lib/commands.js
// Command registry for the Cmd-K action plane. Each command declares an id,
// label, hint, and a run(ctx) function. The palette renders commands the
// same way it renders nav entries; the run() function is what makes Cmd-K
// the universal action surface (dispatch, write memory, set autonomy, …).
//
// The registry is intentionally code-light: a command is a thin wrapper
// around an existing REST endpoint. Server-side authorization is enforced
// by the same authenticateProject / authenticateAdmin middleware that gates
// the underlying routes.

import {
  IconCapture, IconBrain, IconRefresh, IconPlus,
  IconSignals, IconAgents, IconQueues, IconShelly, IconChain,
} from '@/components/icons';

/**
 * Build the full command registry given a context that supplies the
 * primitive operations (apiUrl, apiKey, navigate, prompt, …). The palette
 * filters by fuzzy match and dispatches the chosen command's run().
 *
 * Context shape:
 *   {
 *     apiUrl, apiKey, adminKey,
 *     navigate(tabId),
 *     openModal(name, opts),     // 'capture' | 'memory' | 'param-prompt'
 *     toast({ kind, message }),
 *   }
 */
export function buildCommands(ctx) {
  const cmds = [];

  // ---- Navigation (Flight-deck primary surfaces) ----
  cmds.push(
    { id: 'nav-inbox',    label: 'Go to Inbox',    hint: 'Navigate', icon: null, run: () => ctx.navigate('inbox') },
    { id: 'nav-fleet',    label: 'Go to Fleet',    hint: 'Navigate', icon: null, run: () => ctx.navigate('fleet') },
    { id: 'nav-memory',   label: 'Go to Memory',   hint: 'Navigate', icon: IconBrain, run: () => ctx.navigate('memory') },
    { id: 'nav-settings', label: 'Go to Settings', hint: 'Navigate', icon: null, run: () => ctx.navigate('settings') },
  );

  // ---- Capture ----
  cmds.push({
    id: 'capture-new',
    label: 'New capture',
    hint: 'Capture',
    icon: IconCapture,
    keywords: ['idea', 'thought', 'bug', 'feature', 'todo'],
    run: () => ctx.openModal('capture'),
  });

  // ---- Memory ----
  cmds.push(
    {
      id: 'memory-write',
      label: 'Write a memory',
      hint: 'Memory',
      icon: IconBrain,
      keywords: ['decision', 'retrospective', 'note', 'finding'],
      run: () => ctx.openModal('memory-write'),
    },
    {
      id: 'memory-find',
      label: 'Find memory about…',
      hint: 'Memory',
      icon: IconBrain,
      keywords: ['search', 'recall', 'brief'],
      run: async () => {
        const q = await ctx.openModal('param-prompt', {
          label: 'Find memory about',
          placeholder: 'work_item, tag, keyword…',
        });
        if (q) ctx.navigateWithQuery('memory', { q });
      },
    },
    {
      id: 'memory-recent',
      label: 'Recent memories',
      hint: 'Memory',
      icon: IconBrain,
      run: () => ctx.navigate('memory'),
    },
  );

  // ---- Dispatch (writes against /api/commands proxy → MCP) ----
  cmds.push(
    {
      id: 'dispatch-work-item',
      label: 'Dispatch a work item',
      hint: 'Dispatch',
      icon: IconChain,
      keywords: ['plane', 'devpa', 'zeno', 'edms', 'start'],
      run: async () => {
        const id = await ctx.openModal('param-prompt', {
          label: 'Dispatch work item',
          placeholder: 'DEVPA-93, ZENO-42, or UUID',
        });
        if (!id) return;
        try {
          const r = await fetch(`${ctx.apiUrl}/api/commands/dispatch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': ctx.apiKey },
            body: JSON.stringify({ work_item_id: id.trim() }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = await r.json();
          ctx.toast?.({ kind: 'success', message: `Dispatched ${id} (job ${d.job_id?.slice?.(0, 8) || 'queued'})` });
          ctx.navigate('fleet');
        } catch (e) {
          ctx.toast?.({ kind: 'error', message: `Dispatch failed: ${e.message}` });
        }
      },
    },
    {
      id: 'cancel-job',
      label: 'Cancel a job',
      hint: 'Dispatch',
      icon: IconQueues,
      run: async () => {
        const id = await ctx.openModal('param-prompt', {
          label: 'Cancel job',
          placeholder: 'job_id',
        });
        if (!id) return;
        try {
          const r = await fetch(`${ctx.apiUrl}/api/commands/cancel-job`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': ctx.apiKey },
            body: JSON.stringify({ job_id: id.trim() }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          ctx.toast?.({ kind: 'success', message: `Cancelled ${id}` });
        } catch (e) {
          ctx.toast?.({ kind: 'error', message: `Cancel failed: ${e.message}` });
        }
      },
    },
  );

  // ---- Shelly ----
  cmds.push(
    {
      id: 'shelly-mode-autonomous',
      label: 'Set Shelly mode: autonomous',
      hint: 'Shelly',
      icon: IconShelly,
      run: async () => {
        try {
          await fetch(`${ctx.apiUrl}/api/commands/shelly-mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': ctx.apiKey },
            body: JSON.stringify({ mode: 'autonomous' }),
          });
          ctx.toast?.({ kind: 'success', message: 'Shelly: autonomous' });
        } catch (e) { ctx.toast?.({ kind: 'error', message: e.message }); }
      },
    },
    {
      id: 'shelly-mode-collaborative',
      label: 'Set Shelly mode: collaborative',
      hint: 'Shelly',
      icon: IconShelly,
      run: async () => {
        try {
          await fetch(`${ctx.apiUrl}/api/commands/shelly-mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': ctx.apiKey },
            body: JSON.stringify({ mode: 'collaborative' }),
          });
          ctx.toast?.({ kind: 'success', message: 'Shelly: collaborative' });
        } catch (e) { ctx.toast?.({ kind: 'error', message: e.message }); }
      },
    },
  );

  return cmds;
}
