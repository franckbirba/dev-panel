// src/dashboard/lib/commands.js
// Cmd-K command registry — navigation + action commands.
// Action commands execute via POST /api/commands/:id on the server.
import {
  IconSignals, IconToday, IconInbox, IconQueues, IconOps, IconAgents, IconChain,
  IconShelly, IconProjects, IconSettings, IconPlus,
} from '@/components/icons';

export const commands = [
  // ── Navigation: Operations ──
  { id: 'nav:captures',   label: 'Go to Inbox',      hint: 'Operations',     icon: IconInbox,    type: 'nav', navTarget: 'captures' },
  { id: 'nav:today',      label: 'Go to Today',      hint: 'Operations',     icon: IconToday,    type: 'nav', navTarget: 'today' },
  { id: 'nav:signals',    label: 'Go to Signals',    hint: 'Operations',     icon: IconSignals,  type: 'nav', navTarget: 'signals' },
  // ── Navigation: Infrastructure ──
  { id: 'nav:agents',     label: 'Go to Agents',     hint: 'Infrastructure', icon: IconAgents,   type: 'nav', navTarget: 'agents' },
  { id: 'nav:work-items', label: 'Go to Work items', hint: 'Infrastructure', icon: IconChain,    type: 'nav', navTarget: 'work-items' },
  { id: 'nav:queues',     label: 'Go to Queues',     hint: 'Infrastructure', icon: IconQueues,   type: 'nav', navTarget: 'queues' },
  { id: 'nav:shelly',     label: 'Go to Shelly',     hint: 'Infrastructure', icon: IconShelly,   type: 'nav', navTarget: 'shelly' },
  { id: 'nav:ops',        label: 'Go to Ops',        hint: 'Infrastructure', icon: IconOps,      type: 'nav', navTarget: 'ops' },
  // ── Navigation: Manage ──
  { id: 'nav:projects',   label: 'Go to Projects',   hint: 'Manage',         icon: IconProjects, type: 'nav', navTarget: 'projects' },
  { id: 'nav:settings',   label: 'Go to Settings',   hint: 'Manage',         icon: IconSettings, type: 'nav', navTarget: 'settings' },
  // ── Fleet ──
  { id: 'dispatch',       label: 'Dispatch work item',  hint: 'Fleet',   icon: null, type: 'action', adminOnly: true,
    params: [{ name: 'work_item_id', label: 'Work item ID', placeholder: 'DEVPA-42' }] },
  { id: 'retry-job',      label: 'Retry job',           hint: 'Fleet',   icon: null, type: 'action', adminOnly: true,
    params: [{ name: 'job_id', label: 'Job ID', placeholder: '42' }] },
  { id: 'cancel-job',     label: 'Cancel job',          hint: 'Fleet',   icon: null, type: 'action', adminOnly: true,
    params: [{ name: 'job_id', label: 'Job ID', placeholder: '42' }] },
  { id: 'set-autonomy',   label: 'Set job autonomy',    hint: 'Fleet',   icon: null, type: 'action', adminOnly: true,
    params: [{ name: 'job_id', label: 'Job ID', placeholder: '42' }, { name: 'mode', label: 'Mode', placeholder: 'autonomous | supervised' }] },
  // ── Memory ──
  { id: 'memory-write',   label: 'Write memory',   hint: 'Memory', icon: null, type: 'action', adminOnly: true,
    params: [{ name: 'kind', label: 'Kind', placeholder: 'decision | debug_finding | handoff' }, { name: 'title', label: 'Title', placeholder: '' }, { name: 'content', label: 'Content', placeholder: '' }] },
  { id: 'memory-search',  label: 'Find memory',    hint: 'Memory', icon: null, type: 'action', adminOnly: false,
    params: [{ name: 'query', label: 'Search query', placeholder: 'What to find...' }] },
  { id: 'memory-list',    label: 'Recent memories', hint: 'Memory', icon: null, type: 'action', adminOnly: false },
  { id: 'brief',          label: 'Brief on work item', hint: 'Memory', icon: null, type: 'action', adminOnly: false,
    params: [{ name: 'work_item_id', label: 'Work item ID', placeholder: 'DEVPA-42' }] },
  // ── Captures ──
  { id: 'new-capture',      label: 'New capture',            hint: 'Captures', icon: IconPlus, type: 'action', adminOnly: false,
    params: [{ name: 'content', label: 'Content', placeholder: 'Bug or feature idea...' }] },
  { id: 'route-capture',    label: 'Route capture to label', hint: 'Captures', icon: null,     type: 'action', adminOnly: true,
    params: [{ name: 'capture_id', label: 'Capture ID', placeholder: '42' }, { name: 'label', label: 'Label', placeholder: 'pedago' }] },
  { id: 'promote-capture',  label: 'Promote capture',        hint: 'Captures', icon: null,     type: 'action', adminOnly: true,
    params: [{ name: 'capture_id', label: 'Capture ID', placeholder: '42' }] },
  // ── Shelly ──
  { id: 'shelly-mode',    label: 'Set Shelly mode',    hint: 'Shelly', icon: IconShelly, type: 'action', adminOnly: true,
    params: [{ name: 'mode', label: 'Mode', placeholder: 'active | quiet | off' }] },
  { id: 'shelly-restart', label: 'Restart Shelly',     hint: 'Shelly', icon: IconShelly, type: 'action', adminOnly: true },
  { id: 'shelly-log',     label: 'Last 200 log lines', hint: 'Shelly', icon: null,      type: 'action', adminOnly: false },
  // ── Ops ──
  { id: 'snooze',   label: 'Snooze alerts 24h',  hint: 'Ops', icon: null, type: 'action', adminOnly: true },
  { id: 'escalate', label: 'Escalate to human',  hint: 'Ops', icon: null, type: 'action', adminOnly: false,
    params: [{ name: 'message', label: 'Message', placeholder: 'What needs attention...' }] },
];

export function getCommand(id) {
  return commands.find(c => c.id === id);
}

export async function executeCommand(commandId, params = {}, { adminKey, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminKey) headers['X-Admin-Key'] = adminKey;
  if (apiKey) headers['X-API-Key'] = apiKey;

  const res = await fetch(`${window.location.origin}/api/commands/${commandId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Command failed: ${res.status}`);
  }
  return res.json();
}
