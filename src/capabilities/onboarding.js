// Studio onboarding — make adding a new project/dev/bot a one-line chat ask.
//
// The underlying endpoints (pair_dev_bot MCP tool, /admin/projects/create,
// /admin/studio-members) already exist. These capabilities are the
// chat-facing seams that let Shelly trigger them from a conversation
// without Franck thinking about URLs, body shapes, or API keys.

import { z } from 'zod';
import { adminGet, adminPost } from './_http.js';

// ─── 1) Studio member ──────────────────────────────────────────────────────

export const studioAddMember = {
  name: 'studio_add_member',
  description:
    'Add (or update) a studio member — the person can be DM-ed, can be routed captures, can deploy if can_deploy=true. Idempotent on tg_user_id. Use when Franck says "ajoute Bob, son ID Telegram c\'est X" or "Edwin peut deploy maintenant".',
  paramSchema: z.object({
    tg_user_id: z.union([z.string(), z.number()]).describe('Numeric Telegram user id (e.g. 5663177530).'),
    display_name: z.string().describe('Human name displayed everywhere (e.g. "Bob Dupont").'),
    bot_label: z.string().optional().describe('Short bot name they own (must match dev_bots.label).'),
    projects: z.array(z.string()).optional().describe('Project slugs they are on (e.g. ["zeno", "edms"]).'),
    roles: z.array(z.string()).optional().describe('Free-form role tags ("designer", "backend", ...).'),
    can_deploy: z.boolean().optional().default(false).describe('Allowlist for the deploy gate.'),
    can_approve_merge: z.boolean().optional().default(false),
    default_dm_chat_id: z.union([z.string(), z.number()]).optional().describe('Chat id Telegram should DM (defaults to tg_user_id).'),
  }),
  renderHint: 'StudioMember',
  async handler(body) {
    return await adminPost('/api/admin/studio-members', body);
  },
};

export const studioListMembers = {
  name: 'studio_list_members',
  description:
    'List every studio member with their roles, projects, and deploy/merge permissions. Use when Franck asks "qui est dans le studio?" or before routing a capture.',
  paramSchema: z.object({}),
  renderHint: 'StudioMemberList',
  async handler() {
    return await adminGet('/api/admin/studio-members');
  },
};

// ─── 2) New project ────────────────────────────────────────────────────────

export const studioAddProject = {
  name: 'studio_add_project',
  description:
    'Add a new project to the studio. Parses a GitHub URL, optionally links or creates a Plane project, creates the devpanel row, and returns the new project + its api_key (Shelly should pass that to Franck so he can wire the widget). Use when Franck says "ajoute le repo github.com/x/y comme projet zeno".',
  paramSchema: z.object({
    github_url: z.string().describe('Full GitHub URL of the repo (https://github.com/owner/repo).'),
    plane_mode: z.enum(['skip', 'link', 'create']).default('skip').describe('What to do with Plane: skip = no Plane wiring, link = link to an existing plane_project_id, create = create a new Plane project under devpanl workspace.'),
    plane_project_id: z.string().optional().describe('Required when plane_mode=link.'),
    plane_name: z.string().optional().describe('Project name for plane_mode=create (defaults to GitHub repo name).'),
    name_override: z.string().optional().describe('Devpanel-side project name; defaults to GitHub repo name slugified.'),
    description: z.string().optional(),
  }),
  renderHint: 'Project',
  async handler(body) {
    return await adminPost('/api/admin/projects/create', body);
  },
};

// ─── 3) List projects (admin view for Shelly + the chat panel) ─────────────

export const studioListProjects = {
  name: 'studio_list_projects',
  description:
    'List every devpanel project (with linked Plane id, GitHub repo, default branch, local_path). Use when Franck asks "quels projets j\'ai?" or to find a project_id before wiring something.',
  paramSchema: z.object({}),
  renderHint: 'ProjectList',
  async handler() {
    return await adminGet('/api/admin/projects');
  },
};
