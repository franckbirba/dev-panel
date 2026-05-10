import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  initMasterDatabase,
  listProjects,
  getProjectByName,
  initProjectDatabase,
  listTickets,
  getTicket,
  updateTicket,
  searchDocs,
  getStats,
  getDocStats,
  listMessages,
  addMessage
} from '../server/db.js';
import { embed } from '../server/voyage.js';
import { memoryInsert, memorySearchSql, memoryList, transcriptSearch, transcriptRange } from '../server/pg.js';
import { recordMemoryWrite } from '../server/jobs-log.js';
import { parseTag } from '../server/telegram-tag.js';
import { getSubject } from '../server/subjects.js';
import { getOrCreateThread, appendFromTelegram } from '../server/threads.js';
import {
  listAttachments as planeListAttachments,
  downloadAttachment as planeDownloadAttachment,
  uploadAttachment as planeUploadAttachment
} from './plane-attachments.js';
import {
  listPages as planeListPages,
  getPage as planeGetPage,
  getPageHtml as planeGetPageHtml,
  createPage as planeCreatePage,
  updatePage as planeUpdatePage,
  updatePageContent as planeUpdatePageContent,
  archivePage as planeArchivePage,
  unarchivePage as planeUnarchivePage,
  deletePage as planeDeletePage,
  pagesHealthcheck as planePagesHealthcheck
} from './plane-pages.js';
import {
  getIssue as glitchtipGetIssue,
  resolveIssue as glitchtipResolveIssue
} from './glitchtip.js';
import {
  pairDevBot,
  listDevBots,
  revokeDevBotById,
  listDevBotAllowlist
} from './dev-bots-tools.js';
import { resolveProjectByName, projectFetch } from './projects.js';
import { createCapture } from '../server/captures.js';
import { wrapServerWithProfile, getProfile } from './profile.js';
import { makeAwaitHuman, awaitHumanSchema } from './await-human.js';
import { registerRuntimeTools } from './runtime.js';
import { registerCapabilities } from '../capabilities/index.js';
import { Queue } from 'bullmq';
import { createRequire as createRequireMcp } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const requireMcp = createRequireMcp(import.meta.url);
const RedisMcp = requireMcp('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || '77.42.46.87';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const MODE_FILE = process.env.MODE_FILE || join(process.env.HOME || '/home/deploy', '.shelly-mode.json');
const WORKER_API = process.env.WORKER_API || 'http://localhost:3099';
const API_BASE = process.env.API_BASE || 'https://devpanl.dev';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

const PLANE_BASE = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
const PLANE_SLUG = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
const PLANE_KEY = process.env.PLANE_API_KEY || process.env.PLANE_API_TOKEN || '';

const PRIORITY_MAP = { p0: 1, p1: 5, p2: 10, p3: 20 };

// Resolve a human task_id like "DEVPA-93" to its Plane UUID + title/description.
// Returns { id, project_id, title, description, priority } or null.
// All fetches have a 5s timeout so callers can't hang BullMQ dispatch.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEQ_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/;

async function resolvePlaneWorkItem(idOrSeq) {
  if (!PLANE_KEY) return null;
  const isSeq = SEQ_RE.test(idOrSeq || '');
  const isUuid = UUID_RE.test(idOrSeq || '');
  if (!isSeq && !isUuid) return null;
  const headers = { 'X-API-Key': PLANE_KEY };
  try {
    let wi = null;
    if (isSeq) {
      // Sequence path: workspace-level identifier endpoint (PR #39 fix; the
      // ?sequence= filter is silently ignored by Plane v1.3 and returns the
      // first issue of the project — DEVPA-174 loss of ZENO-238).
      const r = await fetch(
        `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/work-items/${idOrSeq}/`,
        { headers, signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return null;
      wi = await r.json();
    } else {
      // UUID path: the workspace endpoint doesn't accept UUIDs. We don't
      // know which project the UUID belongs to (multi-project workspace),
      // so fan out across known managed projects via the local services
      // admin endpoint, then try each project's work-items/<uuid>/. First
      // 200 wins. This is what was missing for `plane_dispatch_work_item`
      // when called with a UUID instead of a DEVPA-NN sequence — the
      // worker's DEVPA-180 lookup needs project_id, and without resolving
      // it here every UUID dispatch fell back to dev-panel checkout.
      const projects = await fetchManagedProjects();
      for (const p of projects) {
        if (!p.plane_project_id) continue;
        const r = await fetch(
          `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/projects/${p.plane_project_id}/issues/${idOrSeq}/`,
          { headers, signal: AbortSignal.timeout(5000) }
        );
        if (r.ok) { wi = await r.json(); break; }
      }
      if (!wi) return null;
    }
    if (!wi?.id || !wi?.project) return null;
    const desc = (wi.description_html || '')
      .replace(/<\/?(p|div|h[1-6]|li|br)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n').trim();
    return {
      id: wi.id,
      project_id: wi.project,
      title: wi.name,
      description: desc,
      priority: wi.priority,
      sequence_id: wi.sequence_id
    };
  } catch (err) {
    console.warn(`[resolvePlaneWorkItem] ${idOrSeq}: ${err.message}`);
    return null;
  }
}

let _managedProjectsCache = { at: 0, value: [] };
async function fetchManagedProjects() {
  // 5-min cache: project list rarely changes and we hit this from every
  // UUID dispatch fan-out.
  const now = Date.now();
  if (now - _managedProjectsCache.at < 5 * 60 * 1000 && _managedProjectsCache.value.length) {
    return _managedProjectsCache.value;
  }
  const apiBase = process.env.API_BASE;
  const adminKey = process.env.ADMIN_API_KEY;
  if (!apiBase || !adminKey) return [];
  try {
    const r = await fetch(`${apiBase.replace(/\/$/, '')}/api/admin/projects`, {
      headers: { 'X-Admin-Key': adminKey },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return [];
    const body = await r.json();
    const list = body?.projects || [];
    _managedProjectsCache = { at: now, value: list };
    return list;
  } catch (err) {
    console.warn(`[fetchManagedProjects] ${err.message}`);
    return [];
  }
}

let agentsQueue = null;
function getAgentsQueue() {
  if (!agentsQueue) {
    agentsQueue = new Queue('devpanel-agents', {
      connection: new RedisMcp({
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      })
    });
  }
  return agentsQueue;
}

const STORAGE_PATH = process.env.DEVPANEL_STORAGE || './storage';

// Initialize DB
initMasterDatabase(STORAGE_PATH);

const server = new McpServer({
  name: 'dev-panel',
  version: '2.0.0'
});

// Filter tool registrations by MCP_PROFILE. With MCP_PROFILE=public, the
// public Shelly process boots with only the FAQ-safe whitelist (see
// profile.js). Without the env var (or with anything other than "public"),
// the legacy full surface is registered — internal Shelly + worker keep
// every dispatch / write / memory tool they had before.
wrapServerWithProfile(server);
export { server };
export function getRegisteredToolNames() {
  return server.getRegisteredToolNames();
}

// ============================================================================
// TOOLS
// ============================================================================

server.tool(
  'list_projects',
  'List all projects managed by dev-panel',
  {},
  async () => {
    // Source of truth lives on the services API, not the local SQLite.
    // This MCP runs on the agents node where storage/projects.db is empty.
    if (!ADMIN_API_KEY) {
      return {
        content: [{ type: 'text', text: 'ADMIN_API_KEY not configured — cannot query /api/projects.' }],
        isError: true
      };
    }
    try {
      const resp = await fetch(`${API_BASE}/api/projects`, {
        headers: { 'X-Admin-Key': ADMIN_API_KEY }
      });
      if (!resp.ok) {
        const body = await resp.text();
        return {
          content: [{ type: 'text', text: `GET ${API_BASE}/api/projects → ${resp.status}: ${body}` }],
          isError: true
        };
      }
      const { projects = [] } = await resp.json();
      const result = projects.map(p => ({
        name: p.name,
        github: `${p.github_owner}/${p.github_repo}`,
        id: p.id
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to reach ${API_BASE}/api/projects: ${err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  'get_bugs',
  'Get open bugs and feature requests for a project, ordered by priority',
  {
    project: z.string().describe('Project name'),
    status: z.string().default('pending').describe('Filter by status: pending, published, rejected, closed'),
    limit: z.number().default(20).describe('Max results')
  },
  async ({ project, status, limit }) => {
    const proj = getProjectByName(project);
    if (!proj) {
      return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
    }

    initProjectDatabase(STORAGE_PATH, proj.id);
    const tickets = listTickets(STORAGE_PATH, proj.id, { status, limit });

    const result = tickets.map(t => ({
      id: t.id,
      type: t.type,
      status: t.status,
      title: t.title,
      description: t.description,
      github_issue: t.github_issue_url || null,
      created_at: t.created_at,
      created_by: t.created_by
    }));

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'get_context',
  'Search project documentation using full-text search',
  {
    project: z.string().describe('Project name'),
    query: z.string().describe('Search query'),
    limit: z.number().default(10).describe('Max results')
  },
  async ({ project, query, limit }) => {
    const proj = getProjectByName(project);
    if (!proj) {
      return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
    }

    initProjectDatabase(STORAGE_PATH, proj.id);

    try {
      const results = searchDocs(STORAGE_PATH, proj.id, query, limit);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Search error: ${e.message}. Run: dev-panel sync-docs ${project}` }], isError: true };
    }
  }
);

server.tool(
  'get_team_labels',
  'List the routing labels defined on a project (used by Shelly to classify a new ticket).',
  { project: z.string().describe('Project name or UUID') },
  async ({ project }) => {
    try {
      const proj = await resolveProjectByName(project);
      if (!proj) return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
      const r = await projectFetch(proj, '/team/labels');
      if (!r.ok) return { content: [{ type: 'text', text: `GET /api/team/labels → ${r.status}: ${JSON.stringify(r.data)}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `get_team_labels failed: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'get_team_member',
  'Get a team member by id, including their paired Telegram bot info.',
  {
    project: z.string().describe('Project name or UUID'),
    member_id: z.number().describe('team_members.id')
  },
  async ({ project, member_id }) => {
    try {
      const proj = await resolveProjectByName(project);
      if (!proj) return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
      const r = await projectFetch(proj, '/team');
      if (!r.ok) return { content: [{ type: 'text', text: `GET /api/team → ${r.status}: ${JSON.stringify(r.data)}` }], isError: true };
      const member = (r.data?.members ?? []).find(m => m.id === member_id);
      if (!member) return { content: [{ type: 'text', text: `member ${member_id} not found in project "${project}"` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(member, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `get_team_member failed: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'route_ticket',
  'Persist routing for a ticket and return the resolved team member + dev_bot. Idempotent: if the ticket is already routed, returns the existing routing with already_routed=true and ignores the new label.',
  {
    project: z.string().describe('Project name or UUID'),
    ticket_id: z.number().describe('Ticket numeric id'),
    label: z.string().describe('Routing label (e.g. "com", "pedago")')
  },
  async ({ project, ticket_id, label }) => {
    try {
      const proj = await resolveProjectByName(project);
      if (!proj) return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
      const r = await projectFetch(proj, `/tickets/${ticket_id}/route`, {
        method: 'POST',
        body: JSON.stringify({ label })
      });
      if (!r.ok) return { content: [{ type: 'text', text: `POST /api/tickets/${ticket_id}/route → ${r.status}: ${JSON.stringify(r.data)}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `route_ticket failed: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'pr_scan',
  'Scan all managed projects for open GitHub PRs and dispatch a merge-coordinator workflow for any PR without one. Idempotent — safe to re-run. Returns a summary {projects_scanned, prs_seen, dispatched, skipped_active, errors}.',
  {},
  async () => {
    try {
      const { handlePrScanner } = await import('../worker/handlers/pr-scanner.js');
      const summary = await handlePrScanner({});
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `pr_scan failed: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'route_capture',
  'Persist routing for a capture and return the resolved team member + dev_bot. Idempotent: if the capture is already routed, returns the existing routing with already_routed=true and ignores the new label.',
  {
    project: z.string().describe('Project name or UUID'),
    capture_id: z.string().describe('Capture UUID'),
    label: z.string().describe('Routing label (e.g. "com", "pedago")')
  },
  async ({ project, capture_id, label }) => {
    try {
      const proj = await resolveProjectByName(project);
      if (!proj) return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
      const r = await projectFetch(proj, `/captures/${capture_id}/route`, {
        method: 'POST',
        body: JSON.stringify({ label })
      });
      if (!r.ok) return { content: [{ type: 'text', text: `POST /api/captures/${capture_id}/route → ${r.status}: ${JSON.stringify(r.data)}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `route_capture failed: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'update_status',
  'Update the status of a ticket',
  {
    project: z.string().describe('Project name'),
    ticket_id: z.number().describe('Ticket ID'),
    status: z.enum(['pending', 'published', 'rejected', 'closed']).describe('New status')
  },
  async ({ project, ticket_id, status }) => {
    const proj = getProjectByName(project);
    if (!proj) {
      return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
    }

    initProjectDatabase(STORAGE_PATH, proj.id);
    updateTicket(STORAGE_PATH, proj.id, ticket_id, { status });

    return { content: [{ type: 'text', text: `Ticket #${ticket_id} status updated to "${status}"` }] };
  }
);

server.tool(
  'get_messages',
  'Get the conversation thread for a ticket',
  {
    project: z.string().describe('Project name'),
    ticket_id: z.number().describe('Ticket ID')
  },
  async ({ project, ticket_id }) => {
    const proj = getProjectByName(project);
    if (!proj) {
      return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
    }

    initProjectDatabase(STORAGE_PATH, proj.id);
    const messages = listMessages(STORAGE_PATH, proj.id, ticket_id);

    return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] };
  }
);

server.tool(
  'post_message',
  'Post a message to a ticket conversation thread (ask questions, report progress, etc.)',
  {
    project: z.string().describe('Project name'),
    ticket_id: z.number().describe('Ticket ID'),
    content: z.string().describe('Message content'),
    author: z.string().default('shelly').describe('Author name')
  },
  async ({ project, ticket_id, content, author }) => {
    const proj = getProjectByName(project);
    if (!proj) {
      return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
    }

    initProjectDatabase(STORAGE_PATH, proj.id);
    const ticket = getTicket(STORAGE_PATH, proj.id, ticket_id);
    if (!ticket) {
      return { content: [{ type: 'text', text: `Ticket #${ticket_id} not found` }], isError: true };
    }

    addMessage(STORAGE_PATH, proj.id, ticket_id, {
      role: 'agent',
      author,
      content
    });

    return { content: [{ type: 'text', text: `Message posted on ticket #${ticket_id} by ${author}` }] };
  }
);

server.tool(
  'get_project_info',
  'Get project information including stats and GitHub details',
  {
    project: z.string().describe('Project name')
  },
  async ({ project }) => {
    const proj = getProjectByName(project);
    if (!proj) {
      return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
    }

    initProjectDatabase(STORAGE_PATH, proj.id);
    const ticketStats = getStats(STORAGE_PATH, proj.id);
    const docStats = getDocStats(STORAGE_PATH, proj.id);

    const info = {
      name: proj.name,
      github: `${proj.github_owner}/${proj.github_repo}`,
      tickets: ticketStats,
      docs: docStats.count
    };

    return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
  }
);

server.tool(
  'enqueue_job',
  'Low-level: enqueue a job directly on the BullMQ queue. PREFER plane_dispatch_work_item for any dispatch tied to a Plane work item — it auto-resolves DEVPA-xx and fills title/description from Plane. Use this only for unusual one-off agent tasks.',
  {
    agent: z.enum(['builder', 'reviewer', 'pm', 'designer', 'architect', 'qa']).describe('Agent type'),
    task_id: z.string().describe('Task ID from Plane (e.g. DEVPA-42)'),
    task_title: z.string().describe('Task title'),
    task_description: z.string().default('').describe('Task description'),
    skills: z.array(z.string()).default([]).describe('Skill names to inject'),
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).default('p2').describe('Job priority'),
    branch: z.string().optional().describe('Git branch name'),
    source: z.enum(['telegram', 'dashboard', 'cron']).default('telegram')
  },
  async ({ agent, task_id, task_title, task_description, skills, priority, branch, source }) => {
    // Guard: empty-payload dispatches (jobs 42, 44, 113, 114) waste a builder
    // run and get blocked immediately. Force Shelly to bring a real spec.
    const tid = (task_id || '').trim();
    const ttitle = (task_title || '').trim();
    const tdesc = (task_description || '').trim();
    const planeIdPattern = /^[A-Z][A-Z0-9]*-\d+$/;
    if (!planeIdPattern.test(tid) || !ttitle || !tdesc) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'empty_or_invalid_work_item',
            message: 'Refusing to enqueue: need a real Plane work item with title + description. ' +
                     'If Franck asked to "start a job" without an id: first query the Plane backlog, ' +
                     'pick or create a work item in the current cycle with acceptance criteria, ' +
                     'confirm with Franck, then re-call enqueue_job with that work_item id.',
            received: { task_id: tid, task_title: ttitle, task_description_length: tdesc.length },
            expected: { task_id: 'e.g. DEVPA-42 or ZENO-17', task_title: 'non-empty', task_description: 'non-empty with acceptance criteria' }
          }, null, 2)
        }],
        isError: true
      };
    }
    // Cross-repo guard: this legacy path never carried a Plane project_id, so
    // the worker had no way to route the worktree away from dev-panel's
    // PROJECT_ROOT. Result: ZENO/EDMS dispatches got a worktree under
    // /home/deploy/projects/dev-panel/storage/worktrees/<id> and would have
    // pushed onto franckbirba/dev-panel. Block non-DEVPA prefixes here and
    // force the caller through plane_dispatch_work_item, which auto-resolves
    // project_id and feeds the dispatcher's per-project local_path lookup.
    const prefix = tid.split('-')[0];
    if (prefix !== 'DEVPA') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'use_plane_dispatch_work_item',
            message: `enqueue_job is the legacy ad-hoc path with no cross-repo routing — it would land "${tid}" inside dev-panel's PROJECT_ROOT. Call plane_dispatch_work_item({work_item_id: "${tid}"}) instead — it resolves the Plane project_id and routes the worktree to the right repo on the agents host.`,
            task_id: tid
          }, null, 2)
        }],
        isError: true
      };
    }
    try {
      const queue = getAgentsQueue();
      const job = await queue.add(`${agent}:${task_id}`, {
        agent,
        task: {
          id: task_id,
          title: task_title,
          description: task_description,
          branch: branch || `feat/${task_id.toLowerCase()}`
        },
        skills,
        priority,
        source,
        requested_by: 'shelly'
      }, {
        priority: PRIORITY_MAP[priority] || 10,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        timeout: 1800000
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ job_id: job.id, agent, task_id, priority, message: `Job enqueued: ${agent}:${task_id} (priority ${priority})` }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error enqueuing job: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'plane_dispatch_work_item',
  'Start the work-item pipeline on a Plane work-item. Accepts a UUID or a human sequence like DEVPA-93 — sequence gets resolved to UUID and title/description are filled from Plane if omitted. Pass force=true to cancel any stuck active instances (awaiting_approval/blocked/running) for this work item before re-dispatching. This is the preferred entry point for Shelly.',
  {
    work_item_id: z.string().describe('Plane UUID or sequence id like DEVPA-93'),
    module_id: z.string().optional(),
    cycle_id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    workflow: z.enum(['work-item']).default('work-item'),
    force: z.boolean().optional().default(false).describe('Cancel any active instances for this work_item_id before dispatching. Idempotent — no-op if nothing to cancel.')
  },
  async ({ work_item_id, module_id, cycle_id, title, description, workflow, force }) => {
    let resolved_id = work_item_id;
    let plane_project_id;
    let fetched_title;
    let fetched_description;

    // Always resolve via Plane — sequences (DEVPA-93) AND UUIDs both need
    // it now. UUID-only callers (Shelly's `plane_dispatch_work_item` with
    // a UUID, or builder retreats that propagate the resolved id forward)
    // were skipping resolution and dispatching with no project_id, which
    // made the worker fall back to dev-panel's PROJECT_ROOT for every
    // EDMS/Zeno work item — exactly the bug DEVPA-180 was supposed to
    // close. resolvePlaneWorkItem now accepts both forms.
    const wi = await resolvePlaneWorkItem(work_item_id);
    if (!wi) {
      // For UUIDs we don't fail hard — older workflow paths may pass a
      // UUID we can't fan-out to (e.g. a project that's not in the
      // managed `projects` table yet). Fall back to leaving project_id
      // unset; the worker will OOPS with project_not_linked if it needs it.
      if (!UUID_RE.test(work_item_id)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            error: 'plane_lookup_failed',
            message: `Could not resolve "${work_item_id}" to a Plane work item. Check the sequence (e.g. DEVPA-93) and PLANE_API_KEY.`,
          }, null, 2) }],
          isError: true
        };
      }
    } else {
      resolved_id = wi.id;
      plane_project_id = wi.project_id;
      fetched_title = wi.title;
      fetched_description = wi.description;
    }

    // force=true cancels all active instances for this work_item_id
    // BEFORE the dispatch attempt. The unique partial index excludes
    // 'cancelled' so a fresh enqueueWorkflowStart lands cleanly. This
    // replaces the manual `UPDATE workflow_instances SET status=cancelled`
    // dance that operators had to run when a previous attempt left rows
    // stuck in awaiting_approval/blocked.
    let force_cancelled;
    if (force) {
      const { cancelActiveInstances } = await import('../server/workflow-instances.js');
      try {
        const r = await cancelActiveInstances({ work_item_id: resolved_id });
        force_cancelled = r.cancelled_ids;
      } catch (e) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            error: 'force_cancel_failed',
            message: `Could not cancel active instances: ${e.message}`,
          }, null, 2) }],
          isError: true
        };
      }
    }

    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    const out = await enqueueWorkflowStart({
      workflow,
      plane: { work_item_id: resolved_id, project_id: plane_project_id, module_id, cycle_id },
      work_item: {
        title: title || fetched_title,
        description: description || fetched_description
      }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({
        ...out,
        force_cancelled,
        resolved_from: work_item_id !== resolved_id ? work_item_id : undefined,
        work_item_id: resolved_id
      }, null, 2) }],
      isError: !out.ok
    };
  }
);

server.tool(
  'plane_close_cycle',
  'Mark a cycle closed in Plane and schedule its cycle-audit pipeline.',
  {
    cycle_id: z.string(),
    project_id: z.string().describe('Plane project id for the cycle being closed — required; devpanl is multi-project'),
    audit_at: z.string().optional().describe('ISO 8601; defaults to next 09:00 Europe/Paris')
  },
  async ({ cycle_id, project_id, audit_at }) => {
    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    // Step A: mark the cycle closed in Plane. Non-fatal if creds are absent
    // (matches Spec 1 pattern: automation steps no-op when env is unset).
    // NB: project_id is passed in per-call — each devpanl-imported GitHub
    // repo has its own Plane project, so resolving from a global env var
    // would cement the wrong multi-tenant model. Future: resolve from the
    // devpanl projects table based on caller context.
    const base = process.env.PLANE_BASE_URL;
    const slug = process.env.PLANE_WORKSPACE_SLUG;
    const token = process.env.PLANE_API_TOKEN;
    if (base && slug && token && project_id) {
      try {
        await fetch(`${base}/api/v1/workspaces/${slug}/projects/${project_id}/cycles/${cycle_id}/`, {
          method: 'PATCH',
          headers: { 'X-API-Key': token, 'Content-Type': 'application/json',
                     'User-Agent': 'dev-panel/close_cycle' },
          body: JSON.stringify({ end_date: new Date().toISOString() })
        });
      } catch (e) {
        console.warn('[plane_close_cycle] Plane PATCH failed:', e.message);
      }
    }
    // Step B: schedule audit
    const when = audit_at ? Date.parse(audit_at) : nextAuditTime();
    const out = await enqueueWorkflowStart({
      workflow: 'cycle-audit',
      plane: { work_item_id: `cycle:${cycle_id}`, cycle_id },
      work_item: { title: `Cycle audit ${cycle_id}` },
      scheduled_for: when
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...out, scheduled_for: when }, null, 2) }],
      isError: !out.ok
    };
  }
);

server.tool(
  'plane_list_attachments',
  'List file attachments on a Plane work item. Accepts a UUID or a sequence like DEVPA-93. Returns id + name + type + size so you can pick one to download.',
  {
    work_item_id: z.string().describe('Plane UUID or sequence id like DEVPA-93')
  },
  async ({ work_item_id }) => {
    try {
      const rows = await planeListAttachments(work_item_id);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, attachments: rows }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

server.tool(
  'plane_download_attachment',
  'Download a Plane attachment to the local Telegram inbox so Shelly can Read it. Returns the local path + filename + MIME type + size. For PDF/Excel/images/etc. Call plane_list_attachments first to get the attachment_id.',
  {
    work_item_id: z.string().describe('Plane UUID or sequence id like DEVPA-93'),
    attachment_id: z.string().describe('UUID of the attachment (from plane_list_attachments)')
  },
  async ({ work_item_id, attachment_id }) => {
    try {
      const out = await planeDownloadAttachment(work_item_id, attachment_id);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

server.tool(
  'plane_upload_attachment',
  'Upload a local file (e.g. a PDF Franck just dropped in Telegram, path in meta.image_path / attachment) as an attachment on a Plane work item. MIME is guessed from the filename extension; JSON gets stored as text/plain because Plane rejects application/json.',
  {
    work_item_id: z.string().describe('Plane UUID or sequence id like DEVPA-93'),
    file_path: z.string().describe('Absolute path to the local file'),
    name: z.string().optional().describe('Override the filename stored in Plane (defaults to basename of file_path)'),
    type: z.string().optional().describe('Override the MIME type (defaults to a best-guess from the extension)')
  },
  async ({ work_item_id, file_path, name, type }) => {
    try {
      const out = await planeUploadAttachment(work_item_id, file_path, { name, type });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }, null, 2) }],
        isError: true
      };
    }
  }
);

// Resolve a Plane project hint (UUID or short identifier like "DEVPA") to
// the project UUID. The internal pages endpoints require the UUID.
async function resolvePlaneProjectId(hint) {
  if (!hint) throw new Error('project_id is required');
  if (UUID_RE.test(hint)) return hint;
  if (!PLANE_KEY) throw new Error('PLANE_API_KEY missing — cannot resolve project identifier');
  const res = await fetch(
    `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/projects/`,
    { headers: { 'X-API-Key': PLANE_KEY }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`Plane projects lookup failed: HTTP ${res.status}`);
  const list = await res.json();
  const rows = list.results || list;
  const match = rows.find(p => p.identifier?.toLowerCase() === String(hint).toLowerCase()
                            || p.name?.toLowerCase() === String(hint).toLowerCase());
  if (!match) throw new Error(`No Plane project matches "${hint}"`);
  return match.id;
}

server.tool(
  'plane_list_pages',
  'List wiki pages on a Plane project. Accepts a project UUID or a short identifier like "DEVPA"/"ZENO"/"EDMS". Returns id + name + access + archive state for each page.',
  { project: z.string().describe('Plane project UUID or short identifier (DEVPA, ZENO, EDMS)') },
  async ({ project }) => {
    try {
      const pid = await resolvePlaneProjectId(project);
      const rows = await planeListPages(pid);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, pages: rows }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'plane_get_page',
  'Get a single Plane page by id, including description_html (the human-readable body). Use plane_list_pages first to discover page_id.',
  {
    project: z.string().describe('Plane project UUID or short identifier'),
    page_id: z.string().describe('Page UUID')
  },
  async ({ project, page_id }) => {
    try {
      const pid = await resolvePlaneProjectId(project);
      const page = await planeGetPage(pid, page_id);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, page }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'plane_get_page_html',
  'Return only the description_html of a Plane page. Convenience wrapper over plane_get_page when you just need the body to feed back into a prompt or render to markdown.',
  {
    project: z.string().describe('Plane project UUID or short identifier'),
    page_id: z.string().describe('Page UUID')
  },
  async ({ project, page_id }) => {
    try {
      const pid = await resolvePlaneProjectId(project);
      const html = await planeGetPageHtml(pid, page_id);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, description_html: html }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'plane_create_page',
  'Create a new Plane wiki page. Body uses HTML (description_html). Pages default to public access (0); pass access=1 for private.',
  {
    project: z.string().describe('Plane project UUID or short identifier'),
    name: z.string().describe('Page title'),
    description_html: z.string().optional().describe('Initial body in HTML (optional)'),
    access: z.number().optional().describe('0 = public to project, 1 = private to creator (default 0)'),
    parent: z.string().optional().describe('Parent page UUID for sub-pages (optional)')
  },
  async ({ project, name, description_html, access, parent }) => {
    try {
      const pid = await resolvePlaneProjectId(project);
      const page = await planeCreatePage(pid, { name, description_html, access, parent });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, page }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'plane_update_page',
  'Update Plane page metadata (name, access, color, parent, logo_props). To update the body use plane_update_page_content.',
  {
    project: z.string().describe('Plane project UUID or short identifier'),
    page_id: z.string().describe('Page UUID'),
    name: z.string().optional(),
    access: z.number().optional(),
    color: z.string().optional(),
    parent: z.string().nullable().optional(),
    logo_props: z.record(z.string(), z.any()).optional()
  },
  async ({ project, page_id, ...fields }) => {
    try {
      const pid = await resolvePlaneProjectId(project);
      const page = await planeUpdatePage(pid, page_id, fields);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, page }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'plane_update_page_content',
  'Replace the HTML body of a Plane page. WARNING: last-writer-wins — if a human is live-editing the same page in the UI, this PATCH will overwrite their state. For appending, plane_get_page first to read current description_html, concat your addition, then call this.',
  {
    project: z.string().describe('Plane project UUID or short identifier'),
    page_id: z.string().describe('Page UUID'),
    description_html: z.string().describe('New full HTML body')
  },
  async ({ project, page_id, description_html }) => {
    try {
      const pid = await resolvePlaneProjectId(project);
      const out = await planeUpdatePageContent(pid, page_id, description_html);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'plane_archive_page',
  'Archive a Plane page (soft-removes from active list). Pages must be archived before deletion.',
  {
    project: z.string().describe('Plane project UUID or short identifier'),
    page_id: z.string().describe('Page UUID')
  },
  async ({ project, page_id }) => {
    try {
      const pid = await resolvePlaneProjectId(project);
      const out = await planeArchivePage(pid, page_id);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...(out || {}) }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'plane_delete_page',
  'Delete a Plane page. Plane requires archive before delete — pass force=true to chain archive+delete.',
  {
    project: z.string().describe('Plane project UUID or short identifier'),
    page_id: z.string().describe('Page UUID'),
    force: z.boolean().optional().describe('Archive first if not already archived (default false)')
  },
  async ({ project, page_id, force }) => {
    try {
      const pid = await resolvePlaneProjectId(project);
      const out = await planeDeletePage(pid, page_id, { force });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...(out || {}) }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

// ============================================================================
// GLITCHTIP — read/resolve issues from the Sentry-compatible API.
// Inbound bridge (push) lives in src/server/webhooks-glitchtip.js; these
// tools are the matching pull/write surface so Shelly can triage by issue id
// and ephemeral agents can close an issue after merge.
// ============================================================================

server.tool(
  'glitchtip_get_issue',
  'Fetch a GlitchTip (Sentry-compatible) issue by id, returning the metadata + the latest event payload (message, exception, stack, breadcrumbs, tags) needed to triage. Surfaces 401/403 explicitly so a rotated token is visible.',
  {
    org_slug: z.string().describe('GlitchTip organization slug (e.g. "devpanl-studio")'),
    issue_id: z.string().describe('GlitchTip issue id (numeric, surfaces in the alert webhook payload as `id` or in the UI URL)')
  },
  async ({ org_slug, issue_id }) => {
    try {
      const issue = await glitchtipGetIssue(org_slug, issue_id);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, issue }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'glitchtip_resolve_issue',
  'Mark a GlitchTip issue as resolved (PUT status=resolved). Use this after a fix has merged so the issue stops paging. Surfaces 401/403 explicitly.',
  {
    org_slug: z.string().describe('GlitchTip organization slug (e.g. "devpanl-studio")'),
    issue_id: z.string().describe('GlitchTip issue id')
  },
  async ({ org_slug, issue_id }) => {
    try {
      const out = await glitchtipResolveIssue(org_slug, issue_id);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

// Boot smoke test — log loud if Plane Pages internal endpoint is no longer
// reachable (e.g. after a Plane upgrade rewrites the URL). Doesn't block boot.
(async () => {
  try {
    if (!process.env.PLANE_SHELLY_EMAIL) return;
    const sample = process.env.PLANE_SAMPLE_PROJECT_ID || 'd2522fed-e3f2-4eeb-9077-6445261752c1';
    const out = await planePagesHealthcheck(sample);
    if (out.ok) {
      console.log('[plane-pages] OK');
    } else {
      console.warn(`[plane-pages] DEGRADED status=${out.status || 'n/a'} ${out.body || out.error || ''}`);
    }
  } catch (err) {
    console.warn(`[plane-pages] DEGRADED error=${err.message}`);
  }
})();

// nextAuditTime assumes host timezone is Europe/Paris (spec §5.2).
// On a non-Paris-TZ container this shifts by the UTC offset — revisit
// if Europe/Paris scheduling becomes load-bearing.
function nextAuditTime() {
  const now = new Date();
  const t = new Date(now);
  t.setHours(9, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

server.tool(
  'devpanel_workflow_dispatch',
  'Operator override: start any workflow on a work-item (admin). Resolves DEVPA-xx style ids and the Plane project_id so the worker routes the worktree to the right repo.',
  {
    work_item_id: z.string(),
    workflow: z.enum(['work-item', 'cycle-audit']).default('work-item'),
    module_id: z.string().optional(),
    cycle_id: z.string().optional(),
    project_id: z.string().optional().describe('Plane project UUID. Auto-resolved when work_item_id is a sequence like DEVPA-93; pass explicitly only if you already know it.')
  },
  async ({ work_item_id, workflow, module_id, cycle_id, project_id }) => {
    let resolved_id = work_item_id;
    let resolved_project_id = project_id;
    if (!UUID_RE.test(work_item_id)) {
      const wi = await resolvePlaneWorkItem(work_item_id);
      if (!wi) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            error: 'plane_lookup_failed',
            message: `Could not resolve "${work_item_id}" to a Plane work item.`
          }, null, 2) }],
          isError: true
        };
      }
      resolved_id = wi.id;
      resolved_project_id = resolved_project_id || wi.project_id;
    }
    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    const out = await enqueueWorkflowStart({
      workflow,
      plane: { work_item_id: resolved_id, project_id: resolved_project_id, module_id, cycle_id }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      isError: !out.ok
    };
  }
);

server.tool(
  'list_jobs',
  'List jobs in the agents queue by status',
  {
    status: z.enum(['waiting', 'active', 'completed', 'failed', 'delayed']).default('active'),
    limit: z.number().default(10)
  },
  async ({ status, limit }) => {
    try {
      const queue = getAgentsQueue();
      const jobs = await queue.getJobs([status], 0, limit - 1);
      const result = jobs.map(job => ({
        id: job.id,
        name: job.name,
        agent: job.data?.agent,
        task_id: job.data?.task?.id,
        priority: job.opts?.priority,
        attempts: job.attemptsMade,
        created: job.timestamp ? new Date(job.timestamp).toISOString() : null
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error listing jobs: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'cancel_job',
  'Cancel a waiting job or kill an active job',
  {
    job_id: z.string().describe('BullMQ job ID')
  },
  async ({ job_id }) => {
    try {
      const queue = getAgentsQueue();
      const job = await queue.getJob(job_id);
      if (!job) {
        return { content: [{ type: 'text', text: `Job ${job_id} not found` }], isError: true };
      }
      const state = await job.getState();
      if (state === 'active') {
        try {
          const resp = await fetch(`${WORKER_API}/kill/${job_id}`, { method: 'POST' });
          if (resp.ok) {
            return { content: [{ type: 'text', text: `Job ${job_id} kill signal sent` }] };
          }
          return { content: [{ type: 'text', text: `Worker API error: ${resp.status}` }], isError: true };
        } catch {
          return { content: [{ type: 'text', text: `Cannot reach worker API at ${WORKER_API}` }], isError: true };
        }
      }
      await job.remove();
      return { content: [{ type: 'text', text: `Job ${job_id} removed (was ${state})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error cancelling job: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'set_mode',
  'Switch Shelly between autonomous and collaborative mode',
  {
    mode: z.enum(['autonomous', 'collaborative']).describe('Operating mode')
  },
  async ({ mode }) => {
    const state = {
      mode,
      since: new Date().toISOString(),
      morning_review: mode === 'collaborative' ? [] : (
        existsSync(MODE_FILE)
          ? JSON.parse(readFileSync(MODE_FILE, 'utf8')).morning_review || []
          : []
      )
    };
    writeFileSync(MODE_FILE, JSON.stringify(state, null, 2));
    return { content: [{ type: 'text', text: `Mode set to ${mode}` }] };
  }
);

server.tool(
  'get_mode',
  'Get current Shelly operating mode and morning review log',
  {},
  async () => {
    let state = { mode: 'collaborative', since: null, morning_review: [] };
    try {
      if (existsSync(MODE_FILE)) {
        state = JSON.parse(readFileSync(MODE_FILE, 'utf8'));
      }
    } catch { /* ignore */ }
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
  }
);

server.tool(
  'memory_write',
  {
    kind: z.enum(['decision', 'debug_finding', 'spec_note', 'handoff', 'retrospective', 'audit_finding']),
    title: z.string().min(3).max(200),
    content: z.string().min(10),
    tags: z.array(z.string()).optional(),
    module_id: z.string().optional(),
    cycle_id: z.string().optional(),
    work_item_id: z.string().optional()
  },
  async (args) => {
    const namespace = process.env.AGENT_MEMORY_NAMESPACE || 'dev-panel';
    const agent    = process.env.AGENT_ROLE || 'unknown';
    const jobId    = process.env.JOB_ID || null;
    const embedding = await embed(`${args.title}\n\n${args.content}`);
    const id = await memoryInsert({
      namespace, agent, kind: args.kind,
      title: args.title, content: args.content,
      tags: args.tags || [],
      module_id: args.module_id || null,
      cycle_id: args.cycle_id || null,
      work_item_id: args.work_item_id || null,
      embedding
    });
    if (jobId) await recordMemoryWrite(jobId, id);
    return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
  }
);

server.tool(
  'memory_search',
  {
    query: z.string().min(2),
    kind: z.string().optional(),
    agent: z.string().optional(),
    module_id: z.string().optional(),
    limit: z.number().int().min(1).max(20).default(5)
  },
  async (args) => {
    const namespace = process.env.AGENT_MEMORY_NAMESPACE || 'dev-panel';
    const embedding = await embed(args.query, { inputType: 'query' });
    const rows = await memorySearchSql({
      namespace, embedding,
      kind: args.kind || null,
      agent: args.agent || null,
      module_id: args.module_id || null,
      limit: args.limit
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);

server.tool(
  'memory_list',
  {
    kind: z.string().optional(),
    agent: z.string().optional(),
    module_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20)
  },
  async (args) => {
    const namespace = process.env.AGENT_MEMORY_NAMESPACE || 'dev-panel';
    const rows = await memoryList({
      namespace,
      kind: args.kind || null,
      agent: args.agent || null,
      module_id: args.module_id || null,
      limit: args.limit
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);

// ============================================================================
// SHELLY TRANSCRIPT — verbatim conversation log
//
// Why these exist: Claude Code auto-compacts long conversations. Shelly's
// system prompt + earlier turns get summarized into a lossy bullet list,
// and after ~12-19h of activity she "forgets" context Franck still expects
// her to know. The shelly_transcript table (services-side Postgres,
// migration 009) stores every inbound DM and every outbound reply
// verbatim, time-indexed, with FTS + trigram indexes for fast search.
// These tools let Shelly query that log to rebuild context.
//
// Read path is one-way: Shelly reads transcripts. The plugin writes them
// (plugins/telegram-multi/src/loader.ts#recordTranscript). No write tool
// here — agents shouldn't be able to forge or delete transcript rows.
// ============================================================================

// transcript_search — keyword search across all-time, with optional time
// range + facets. Use when Franck asks about something from "yesterday" or
// "last week" by topic.
server.tool(
  'transcript_search',
  {
    query: z.string().min(2).describe(
      'Plain-text keyword(s) to search. No tsquery syntax needed; we use ' +
      'plainto_tsquery + ILIKE substring fallback.'
    ),
    since: z.string().optional().describe(
      'ISO 8601 lower bound, e.g. "2026-05-09" or "2026-05-09T00:00:00Z". ' +
      'Inclusive. Optional.'
    ),
    until: z.string().optional().describe(
      'ISO 8601 upper bound. Inclusive. Optional.'
    ),
    bot_label: z.string().optional().describe(
      'Filter to one paired bot (franck, alice, …). Omit for all bots.'
    ),
    thread_subject: z.string().optional().describe(
      'Filter to messages tagged with a specific thread, e.g. "capture/47" ' +
      'or "work_item/<UUID>". Omit for untagged + all tags.'
    ),
    direction: z.enum(['in','out']).optional().describe(
      '"in" = user → Shelly, "out" = Shelly → user. Omit for both.'
    ),
    limit: z.number().int().min(1).max(200).default(50)
  },
  async (args) => {
    const rows = await transcriptSearch({
      query: args.query,
      since: args.since || null,
      until: args.until || null,
      bot_label: args.bot_label || null,
      thread_subject: args.thread_subject || null,
      direction: args.direction || null,
      limit: args.limit
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);

// transcript_range — pure time-range scan, no query. For "what happened
// since X" use cases (post-restart context restoration, "give me the last
// 24h on alice's bot"). Returns ascending by ts so Shelly can replay in
// order. Required `since` prevents accidental whole-table scans.
server.tool(
  'transcript_range',
  {
    since: z.string().describe(
      'ISO 8601 lower bound (REQUIRED). e.g. "2026-05-09T18:00:00Z".'
    ),
    until: z.string().optional(),
    bot_label: z.string().optional(),
    thread_subject: z.string().optional(),
    direction: z.enum(['in','out']).optional(),
    limit: z.number().int().min(1).max(500).default(200)
  },
  async (args) => {
    const rows = await transcriptRange({
      since: args.since,
      until: args.until || null,
      bot_label: args.bot_label || null,
      thread_subject: args.thread_subject || null,
      direction: args.direction || null,
      limit: args.limit
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);

// transcript_replay_recent — convenience wrapper over transcript_range with
// `since = now() - minutes`. Use this on Shelly's first turn after a
// restart: replay the last 4h to rebuild context.
server.tool(
  'transcript_replay_recent',
  {
    minutes: z.number().int().min(5).max(1440).default(240).describe(
      'How far back to scan. Default 240 = 4 hours. Max 24h.'
    ),
    bot_label: z.string().optional(),
    direction: z.enum(['in','out']).optional(),
    limit: z.number().int().min(1).max(500).default(200)
  },
  async (args) => {
    const since = new Date(Date.now() - args.minutes * 60 * 1000).toISOString();
    const rows = await transcriptRange({
      since,
      bot_label: args.bot_label || null,
      direction: args.direction || null,
      limit: args.limit
    });
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);

// ============================================================================
// THREAD APPEND — inbound Telegram message → dashboard thread
// ============================================================================

export async function handleThreadAppend({ raw_text, role, telegram_message_id }) {
  const parsed = parseTag(raw_text);
  if (!parsed) {
    await recordUntaggedDrop({ raw_text, role, telegram_message_id });
    return { appended: false, reason: 'no tag in message' };
  }
  const base = process.env.API_BASE || 'http://localhost:3030';
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return { appended: false, reason: 'ADMIN_API_KEY not set' };
  // Default role = 'user'. thread_append is called by the Telegram plugin when
  // an inbound message arrives — inbound means Franck typing. Shelly's own
  // replies go through a separate path. Previous 'shelly' default caused every
  // Franck message to show up in the dashboard as if Shelly authored it.
  const resolvedRole = role || 'user';
  try {
    const r = await fetch(`${base}/api/threads/${parsed.subject_type}/${parsed.subject_id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        content: parsed.body,
        role: resolvedRole,
        source: 'telegram',
        telegram_message_id
      })
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      return { appended: false, reason: `api ${r.status}: ${err.slice(0, 200)}` };
    }
    const data = await r.json();
    return { appended: true, thread_id: data.thread_id, role: resolvedRole };
  } catch (err) {
    return { appended: false, reason: `fetch failed: ${err.message}` };
  }
}

async function recordUntaggedDrop({ raw_text, role, telegram_message_id }) {
  const base = process.env.API_BASE || 'http://localhost:3030';
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return;
  try {
    await fetch(`${base}/api/admin/telegram-drops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ raw_text, role: role || null, telegram_message_id: telegram_message_id ?? null })
    }).catch(() => {});
  } catch {}
}

server.tool(
  'thread_append',
  'Forward a tagged Telegram message into the dashboard\'s thread for the matching subject. Use when the user (or another bot) sends a message starting with [thread:type/id]. Default role is "user" (Franck typing from Telegram); Shelly must pass role="shelly" explicitly when relaying her own replies.',
  {
    raw_text: z.string().describe('Full message text including the [thread:type/id] prefix'),
    role: z.string().default('user').describe('user | shelly | agent — defaults to user (inbound Telegram = Franck)'),
    telegram_message_id: z.number().describe('Telegram message_id for dedup')
  },
  async ({ raw_text, role, telegram_message_id }) => {
    const result = await handleThreadAppend({ raw_text, role, telegram_message_id });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

// ============================================================================
// READ-ONLY PLANE work-item helpers — used by Shelly publique to look up
// work items when answering FAQ questions, without exposing the upstream
// plane-mcp-server (which ships create_work_item / update_work_item /
// delete_work_item alongside the read tools we want).
// ============================================================================

server.tool(
  'list_work_items',
  'List work items for a Plane project. Read-only. Accepts a project UUID or a short identifier like "DEVPA"/"ZENO"/"EDMS". Returns id, sequence_id, name, state, priority for each item.',
  {
    project: z.string().describe('Plane project UUID or short identifier (DEVPA, ZENO, EDMS)'),
    limit: z.number().int().min(1).max(100).default(50).describe('Max items returned (default 50)')
  },
  async ({ project, limit }) => {
    try {
      if (!PLANE_KEY) throw new Error('PLANE_API_KEY missing');
      const pid = await resolvePlaneProjectId(project);
      const res = await fetch(
        `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/projects/${pid}/issues/?per_page=${limit}`,
        { headers: { 'X-API-Key': PLANE_KEY }, signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) throw new Error(`Plane HTTP ${res.status}`);
      const data = await res.json();
      const rows = (data.results || data).slice(0, limit).map(w => ({
        id: w.id,
        sequence_id: w.sequence_id,
        name: w.name,
        state: w.state,
        priority: w.priority
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, work_items: rows }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'retrieve_work_item',
  'Fetch a single Plane work item by UUID or sequence (e.g. "DEVPA-93"). Read-only. Returns name, description (text), state, priority, labels.',
  {
    work_item_id: z.string().describe('Plane UUID or sequence id like DEVPA-93')
  },
  async ({ work_item_id }) => {
    try {
      if (!PLANE_KEY) throw new Error('PLANE_API_KEY missing');
      let resolved;
      if (UUID_RE.test(work_item_id)) {
        // Need project_id to call retrieve. Cheapest path is the issues
        // search endpoint by id, but Plane only exposes per-project endpoints
        // — we have to look the item up workspace-wide first. The list_work_items
        // path is for browsing; one-shot retrieve by UUID requires walking
        // projects until we hit it. In practice callers pass DEVPA-NN which is
        // fast, so the UUID branch is a graceful fallback.
        const projects = await fetch(
          `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/projects/`,
          { headers: { 'X-API-Key': PLANE_KEY }, signal: AbortSignal.timeout(5000) }
        ).then(r => r.ok ? r.json() : { results: [] });
        for (const p of (projects.results || projects)) {
          const r = await fetch(
            `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/projects/${p.id}/issues/${work_item_id}/`,
            { headers: { 'X-API-Key': PLANE_KEY }, signal: AbortSignal.timeout(5000) }
          );
          if (r.ok) { resolved = await r.json(); resolved.project_id = p.id; break; }
        }
        if (!resolved) throw new Error(`work item ${work_item_id} not found in any project`);
      } else {
        resolved = await resolvePlaneWorkItem(work_item_id);
        if (!resolved) throw new Error(`Could not resolve "${work_item_id}"`);
      }
      const out = {
        id: resolved.id,
        project_id: resolved.project_id,
        sequence_id: resolved.sequence_id || null,
        name: resolved.name || resolved.title,
        description: resolved.description || null,
        state: resolved.state,
        priority: resolved.priority,
        labels: resolved.label_ids || resolved.labels || []
      };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, work_item: out }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'plane_list_estimate_points',
  'List estimate points (complexity levels) for a Plane project that uses complexity-based estimates. Accepts a project UUID or short identifier (DEVPA/ZENO/EDMS). Returns estimate_id and points array with {id, key, value} for each complexity level. If the project has no estimate configuration, returns estimate_id=null with empty points array.',
  {
    project: z.string().describe('Plane project UUID or short identifier (DEVPA, ZENO, EDMS)')
  },
  async ({ project }) => {
    try {
      if (!PLANE_KEY) throw new Error('PLANE_API_KEY missing');
      const pid = await resolvePlaneProjectId(project);

      // Fetch project details to get estimate_id
      const projectRes = await fetch(
        `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/projects/${pid}/`,
        { headers: { 'X-API-Key': PLANE_KEY }, signal: AbortSignal.timeout(5000) }
      );
      if (!projectRes.ok) throw new Error(`Plane project fetch failed: HTTP ${projectRes.status}`);
      const projectData = await projectRes.json();
      const estimate_id = projectData.estimate_id || null;

      // If no estimate configuration, return empty points
      if (!estimate_id) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, estimate_id: null, points: [] }, null, 2)
            }
          ]
        };
      }

      // Fetch estimate points
      const estimateRes = await fetch(
        `${PLANE_BASE}/api/v1/workspaces/${PLANE_SLUG}/projects/${pid}/estimates/${estimate_id}/estimate-points/`,
        { headers: { 'X-API-Key': PLANE_KEY }, signal: AbortSignal.timeout(5000) }
      );
      if (!estimateRes.ok) throw new Error(`Plane estimate points fetch failed: HTTP ${estimateRes.status}`);
      const estimateData = await estimateRes.json();
      const points = (estimateData.results || estimateData).map(p => ({
        id: p.id,
        key: p.key,
        value: p.value
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, estimate_id, points }, null, 2)
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }],
        isError: true
      };
    }
  }
);

// ============================================================================
// DEV-BOTS — pair / list / revoke Telegram bots and inspect the DM allowlist.
// Mirrors the HTTP surface in src/server/routes-dev-bots.js so Shelly can
// honour the /pair <token> <label> protocol from the SOUL without needing
// fetch (which her hard rules forbid). All four tools are admin-only —
// excluded from MCP_PROFILE=public via not being in PUBLIC_TOOL_WHITELIST.
// ============================================================================

server.tool(
  'pair_dev_bot',
  'Pair a new Telegram bot under a short label. Validates the token via Telegram getMe, inserts a dev_bots row, and auto-allowlists the pairer so they can DM the bot. Returns the serialized row (BigInt fields stringified). Use when Franck DMs you `/pair <token> <label>`.',
  {
    token: z.string().describe('Telegram bot token from @BotFather (looks like 1234:abc...)'),
    label: z.string().describe('Short bot name (e.g. "alice", "franck") — must be unique across dev_bots'),
    paired_by_tg_user_id: z.union([z.string(), z.number()]).describe('Telegram user_id of the pairer (e.g. Franck = 5663177530). Stringified BigInt acceptable.')
  },
  async ({ token, label, paired_by_tg_user_id }) => {
    try {
      const row = await pairDevBot({ token, label, paired_by_tg_user_id });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dev_bot: row }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, code: err.code || 'error' }) }],
        isError: true
      };
    }
  }
);

server.tool(
  'list_dev_bots',
  'List paired Telegram bots. Pass status="active" to filter to non-revoked rows; omit for all rows including revoked. BigInt fields are stringified.',
  {
    status: z.enum(['active', 'all']).optional().describe('"active" filters to status=active; default lists all rows including revoked.')
  },
  async ({ status }) => {
    try {
      const rows = await listDevBots({ status });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dev_bots: rows }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'revoke_dev_bot',
  'Mark a paired bot as revoked (telegram-multi will stop polling it). Idempotent — calling on an already-revoked or missing id is a no-op.',
  {
    id: z.union([z.string(), z.number()]).describe('dev_bots.id (integer; accepts string or number)')
  },
  async ({ id }) => {
    try {
      const out = await revokeDevBotById({ id });
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, code: err.code || 'error' }) }],
        isError: true
      };
    }
  }
);

server.tool(
  'list_dev_bot_allowlist',
  'List entries in the dev_bot_allowlist table — the set of Telegram user_ids the telegram-multi plugin will accept inbound DMs from. Useful for visibility/debug when a paired dev cannot DM their bot.',
  {},
  async () => {
    try {
      const rows = await listDevBotAllowlist();
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, allowlist: rows }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

// ============================================================================
// CAPTURE — file a bug/feature from the widget chat. Public Shelly's only
// write surface beyond thread_append. Always status='new' so the internal
// triage pipeline (Shelly interne, dashboard inbox) catches it.
// ============================================================================

server.tool(
  'capture_create',
  'File a new bug or feature capture on behalf of a widget user. Always created with status=new so internal Shelly triages it the same way as any other inbox item. Pass kind="bug" or kind="idea" (default "idea"). Optional reporter object carries widget user identity.',
  {
    project_id: z.string().describe('DevPanel project id (UUID) — comes from the widget config'),
    content: z.string().min(1).describe('Free-text description of the bug or feature'),
    kind: z.enum(['idea', 'bug']).default('idea').describe('"bug" or "idea" (default "idea")'),
    created_by: z.string().default('widget').describe('Author label (defaults to "widget")'),
    reporter: z.record(z.string(), z.any()).optional().describe('Optional widget-user identity: { id, name, email, ... }'),
    environment: z.string().optional().describe('Optional environment hint (e.g. "production", "staging")')
  },
  async ({ project_id, content, kind, created_by, reporter, environment }) => {
    try {
      const capture = createCapture({ project_id, content, kind, created_by, reporter, environment });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          capture_id: capture.id,
          status: capture.status,
          project_id: capture.project_id
        }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
    }
  }
);

server.tool(
  'list_captures',
  'List pending captures across DevPanel projects for triage. Admin-keyed (ADMIN_API_KEY) so it works from the agents host without per-project credentials. Defaults to status=new. Returns id, project_id, project_name, content, kind, status, environment, reporter, created_at, plane_work_item_id, plane_sequence_id.',
  {
    project_id: z.string().optional().describe('DevPanel project UUID — omit to list across every managed project'),
    status: z.enum(['new', 'triaging', 'promoted', 'dropped']).default('new').describe('Capture lifecycle state (default "new")'),
    kind: z.enum(['bug', 'idea']).optional().describe('Filter on capture kind'),
    limit: z.number().int().min(1).max(200).default(50).describe('Max rows to return (default 50, max 200)')
  },
  async ({ project_id, status, kind, limit }) => {
    if (!ADMIN_API_KEY) {
      return { content: [{ type: 'text', text: 'ADMIN_API_KEY not configured — list_captures requires admin auth.' }], isError: true };
    }
    try {
      const params = new URLSearchParams();
      if (project_id) params.set('project_id', project_id);
      if (status) params.set('status', status);
      if (kind) params.set('kind', kind);
      if (limit) params.set('limit', String(limit));
      const url = `${API_BASE}/api/admin/captures${params.toString() ? `?${params}` : ''}`;
      const r = await fetch(url, { headers: { 'X-Admin-Key': ADMIN_API_KEY } });
      if (!r.ok) {
        const body = await r.text();
        return { content: [{ type: 'text', text: `GET ${url} → ${r.status}: ${body}` }], isError: true };
      }
      const { captures = [] } = await r.json();
      const result = captures.map(c => ({
        id: c.id,
        project_id: c.project_id,
        project_name: c.project_name,
        kind: c.kind,
        status: c.status,
        content: c.content,
        environment: c.environment,
        reporter: c.reporter,
        created_at: c.created_at,
        plane_work_item_id: c.plane_work_item_id,
        plane_sequence_id: c.plane_sequence_id
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `list_captures failed: ${err.message}` }], isError: true };
    }
  }
);

// ============================================================================
// HITL — agent asks a human a question and waits for the answer.
// Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md
// ============================================================================

// JOB_ID is injected by the worker at spawn time (src/worker/index.js:203).
// Without it the tool can't know which job's inbox to write to, so we
// register it conditionally — agents running outside a worker context (e.g.
// human-driven Shelly sessions) won't see this tool.
if (process.env.JOB_ID && ADMIN_API_KEY) {
  const awaitHumanImpl = makeAwaitHuman({
    apiBase: API_BASE,
    adminKey: ADMIN_API_KEY,
    jobId: process.env.JOB_ID,
    workItemId: process.env.WORK_ITEM_ID || null,
    workflowName: process.env.WORKFLOW_NAME || null,
  });

  server.tool(
    'await_human',
    'Pause and ask the human a question. The agent blocks here until a reply lands (via dashboard or Telegram), or until timeout. Use for: ambiguity you cannot resolve safely, decisions outside your authority (deploy, prod schema), confirmations before destructive ops. Return is { answer, source } — answer is the human\'s text, source is "human" or "timeout-default". One question per call. Be specific in the prompt.',
    awaitHumanSchema(),
    async (args) => {
      try {
        const result = await awaitHumanImpl(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `await_human failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

// ============================================================================
// RUNTIME TOOLS (DEVPA-201..203)
// tail_log / run_remote / ssh_status — replace 5 of 9 tmux-cockpit windows.
// ============================================================================

registerRuntimeTools(server);

// ============================================================================
// CAPABILITIES (DEVPA-210)
// Intent-shaped tools the chat + Pi-Shelly see by default. Each capability
// wraps one or more raw tools above into a single verb that doesn't make the
// LLM re-derive the workflow on every turn. Cards in apps/chat are bound
// 1:1 by `renderHint`. See src/capabilities/index.js.
// ============================================================================

registerCapabilities(server);

// ============================================================================
// START
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// MCP_NO_AUTOSTART lets tests import this module to introspect the tool
// registry without binding stdio (which would race with the test harness).
// Production launches always leave this unset.
if (!process.env.MCP_NO_AUTOSTART) {
  main().catch(console.error);
}
