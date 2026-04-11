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
  getDocStats
} from '../server/db.js';

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
  'ask_clarification',
  'Ask the admin a clarification question about a ticket',
  {
    project: z.string().describe('Project name'),
    ticket_id: z.number().describe('Ticket ID'),
    question: z.string().describe('The clarification question')
  },
  async ({ project, ticket_id, question }) => {
    const proj = getProjectByName(project);
    if (!proj) {
      return { content: [{ type: 'text', text: `Project "${project}" not found` }], isError: true };
    }

    initProjectDatabase(STORAGE_PATH, proj.id);
    const ticket = getTicket(STORAGE_PATH, proj.id, ticket_id);
    if (!ticket) {
      return { content: [{ type: 'text', text: `Ticket #${ticket_id} not found` }], isError: true };
    }

    const context = ticket.context || {};
    if (!context.clarifications) context.clarifications = [];
    context.clarifications.push({
      question,
      asked_at: new Date().toISOString(),
      answer: null
    });

    updateTicket(STORAGE_PATH, proj.id, ticket_id, {
      context: JSON.stringify(context),
      status: 'pending'
    });

    return { content: [{ type: 'text', text: `Clarification question posted on ticket #${ticket_id}. Waiting for admin response.` }] };
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

// ============================================================================
// START
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
