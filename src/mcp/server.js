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

// ============================================================================
// START
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
