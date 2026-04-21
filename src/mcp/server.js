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
import { memoryInsert, memorySearchSql, memoryList } from '../server/pg.js';
import { recordMemoryWrite } from '../server/jobs-log.js';
import { parseTag } from '../server/telegram-tag.js';
import { getSubject } from '../server/subjects.js';
import { getOrCreateThread, appendFromTelegram } from '../server/threads.js';
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

const PRIORITY_MAP = { p0: 1, p1: 5, p2: 10, p3: 20 };

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

// ============================================================================
// TOOLS
// ============================================================================

server.tool(
  'list_projects',
  'List all projects managed by dev-panel',
  {},
  async () => {
    const projects = listProjects();
    const result = projects.map(p => ({
      name: p.name,
      github: `${p.github_owner}/${p.github_repo}`,
      id: p.id
    }));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
  'Enqueue a job for an agent in the BullMQ queue',
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
  'Start the work-item pipeline on a Plane work-item (PM-owned dispatch).',
  {
    work_item_id: z.string(),
    module_id: z.string().optional(),
    cycle_id: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    workflow: z.enum(['work-item']).default('work-item')
  },
  async ({ work_item_id, module_id, cycle_id, title, description, workflow }) => {
    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    const out = await enqueueWorkflowStart({
      workflow,
      plane: { work_item_id, module_id, cycle_id },
      work_item: { title, description }
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
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
  'Operator override: start any workflow on a work-item (admin).',
  {
    work_item_id: z.string(),
    workflow: z.enum(['work-item', 'cycle-audit']).default('work-item'),
    module_id: z.string().optional(),
    cycle_id: z.string().optional()
  },
  async ({ work_item_id, workflow, module_id, cycle_id }) => {
    const { enqueueWorkflowStart } = await import('../worker/dispatch.js');
    const out = await enqueueWorkflowStart({
      workflow,
      plane: { work_item_id, module_id, cycle_id }
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
    if (jobId) recordMemoryWrite(jobId, id);
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
// THREAD APPEND — inbound Telegram message → dashboard thread
// ============================================================================

export async function handleThreadAppend({ raw_text, role, telegram_message_id }) {
  const parsed = parseTag(raw_text);
  if (!parsed) return { appended: false, reason: 'no tag in message' };
  if (!getSubject(parsed.subject_type, parsed.subject_id)) {
    return { appended: false, reason: `unknown subject ${parsed.subject_type}/${parsed.subject_id}` };
  }
  const thread = getOrCreateThread(parsed.subject_type, parsed.subject_id);
  const id = appendFromTelegram({
    thread_id: thread.thread_id,
    role: role || 'shelly',
    content: parsed.body,
    telegram_message_id
  });
  if (id != null) {
    try {
      const { broadcast } = await import('../server/sse.js');
      broadcast('thread:message', {
        thread_id: thread.thread_id,
        message: { id, role, source: 'telegram', content: parsed.body, created_at: new Date().toISOString() }
      });
    } catch (e) { /* SSE may not be initialised in MCP context */ }
  }
  return { appended: id != null, thread_id: thread.thread_id };
}

server.tool(
  'thread_append',
  'Forward a tagged Telegram message into the dashboard\'s thread for the matching subject. Use when the user (or another bot) sends a message starting with [thread:type/id].',
  {
    raw_text: z.string().describe('Full message text including the [thread:type/id] prefix'),
    role: z.string().default('shelly').describe('user | shelly | agent'),
    telegram_message_id: z.number().describe('Telegram message_id for dedup')
  },
  async ({ raw_text, role, telegram_message_id }) => {
    const result = await handleThreadAppend({ raw_text, role, telegram_message_id });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

// ============================================================================
// START
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
