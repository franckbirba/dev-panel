import { Command } from 'commander';
import { join } from 'path';
import { readFileSync } from 'fs';
import {
  initMasterDatabase,
  createProject,
  listProjects,
  getProjectByName,
  getProjectById,
  updateProject,
  deleteProject as dbDeleteProject
} from '../../server/db.js';

const adminCommand = new Command('admin')
  .description('Admin commands for managing projects');

// Create project
adminCommand
  .command('create')
  .description('Create a new project')
  .requiredOption('-n, --name <name>', 'Project name')
  .requiredOption('-o, --owner <owner>', 'GitHub owner/org')
  .requiredOption('-r, --repo <repo>', 'GitHub repo name')
  .option('-t, --token <token>', 'GitHub token (or use GITHUB_TOKEN env var)')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .action(async (options) => {
    try {
      // Initialize master database
      initMasterDatabase(options.storage);

      const githubToken = options.token || process.env.GITHUB_TOKEN;

      if (!githubToken) {
        console.error('❌ GitHub token required. Provide via --token or GITHUB_TOKEN env var.');
        process.exit(1);
      }

      // Create project
      const project = createProject({
        name: options.name,
        github_owner: options.owner,
        github_repo: options.repo,
        github_token: githubToken
      });

      console.log('\n✅ Project created successfully!\n');
      console.log('Project Details:');
      console.log('━'.repeat(60));
      console.log(`Name:       ${project.name}`);
      console.log(`ID:         ${project.id}`);
      console.log(`API Key:    ${project.api_key}`);
      console.log(`GitHub:     ${options.owner}/${options.repo}`);
      console.log('━'.repeat(60));
      console.log('\nAdd this to your project\'s .env.local:');
      console.log(`DEV_PANEL_URL=http://localhost:3030`);
      console.log(`DEV_PANEL_API_KEY=${project.api_key}`);
      console.log('');

    } catch (error) {
      console.error('❌ Error creating project:', error.message);
      process.exit(1);
    }
  });

// List projects
adminCommand
  .command('list')
  .description('List all projects')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .action(async (options) => {
    try {
      initMasterDatabase(options.storage);

      const projects = listProjects();

      if (projects.length === 0) {
        console.log('No projects found.');
        return;
      }

      console.log('\n📋 Projects\n');
      console.log('┌────────────────────────────────────┬─────────────────────────┬─────────────────────────┬────────────┐');
      console.log('│ Name                               │ GitHub                  │ API Key                 │ Created    │');
      console.log('├────────────────────────────────────┼─────────────────────────┼─────────────────────────┼────────────┤');

      projects.forEach(p => {
        const name = (p.name || '').padEnd(34).substring(0, 34);
        const github = `${p.github_owner}/${p.github_repo}`.padEnd(23).substring(0, 23);
        const apiKey = (p.api_key || '').substring(0, 23).padEnd(23);
        const created = new Date(p.created_at).toLocaleDateString().padEnd(10);

        console.log(`│ ${name} │ ${github} │ ${apiKey} │ ${created} │`);
      });

      console.log('└────────────────────────────────────┴─────────────────────────┴─────────────────────────┴────────────┘');
      console.log(`\nTotal: ${projects.length} projects\n`);

    } catch (error) {
      console.error('❌ Error listing projects:', error.message);
      process.exit(1);
    }
  });

// Show project details
adminCommand
  .command('show <name>')
  .description('Show project details')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .action(async (name, options) => {
    try {
      initMasterDatabase(options.storage);

      const project = getProjectByName(name);

      if (!project) {
        console.error(`❌ Project "${name}" not found.`);
        process.exit(1);
      }

      console.log('\n📄 Project Details\n');
      console.log('━'.repeat(60));
      console.log(`Name:         ${project.name}`);
      console.log(`ID:           ${project.id}`);
      console.log(`GitHub:       ${project.github_owner}/${project.github_repo}`);
      console.log(`API Key:      ${project.api_key}`);
      console.log(`Created:      ${new Date(project.created_at).toLocaleString()}`);
      console.log(`Updated:      ${new Date(project.updated_at).toLocaleString()}`);
      console.log('━'.repeat(60));
      console.log('');

    } catch (error) {
      console.error('❌ Error showing project:', error.message);
      process.exit(1);
    }
  });

// Backfill missing fields on a legacy project record (created before
// /api/projects/bootstrap existed) and optionally enqueue the
// bootstrap_project job that does `git clone` on the agents host.
//
// Idempotent: every field is only written when --force or when currently
// null. Re-running with the same args leaves the row untouched once it's
// fully populated.
adminCommand
  .command('link-project <name>')
  .description('Backfill plane_project_id / local_path / default_branch on a legacy project, then optionally enqueue bootstrap_project to clone it on the agents host')
  .option('--plane-id <uuid>', 'Plane project UUID (required if not already set)')
  .option('--plane-slug <slug>', 'Plane workspace slug', 'devpanl')
  .option('--local-path <path>', 'Local checkout path on the agents host (defaults to /home/deploy/projects/<github_repo>)')
  .option('--default-branch <name>', 'Default branch (defaults to "main")', 'main')
  .option('--enqueue-bootstrap', 'After backfill, enqueue bootstrap_project so the worker clones the repo')
  .option('--force', 'Overwrite fields that are already set')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .action(async (name, options) => {
    try {
      initMasterDatabase(options.storage);

      const project = getProjectByName(name);
      if (!project) {
        console.error(`❌ Project "${name}" not found.`);
        process.exit(1);
      }

      // Decide each field — keep existing value unless --force, fall back
      // to a sensible default if the user didn't pass an override.
      const pick = (current, override, fallback) => {
        if (options.force) return override ?? fallback ?? current;
        return current ?? override ?? fallback;
      };

      const updates = {};
      const planeId = pick(project.plane_project_id, options.planeId, null);
      if (planeId !== project.plane_project_id) updates.plane_project_id = planeId;

      const planeSlug = pick(project.plane_workspace_slug, options.planeSlug, 'devpanl');
      if (planeSlug !== project.plane_workspace_slug) updates.plane_workspace_slug = planeSlug;

      const defaultBranch = pick(project.default_branch, options.defaultBranch, 'main');
      if (defaultBranch !== project.default_branch) updates.default_branch = defaultBranch;

      const reposBase = process.env.AGENTS_HOST_PROJECTS_PATH || '/home/deploy/projects';
      const inferredPath = project.github_repo ? `${reposBase}/${project.github_repo}` : null;
      const localPath = pick(project.local_path, options.localPath, inferredPath);
      if (localPath !== project.local_path) updates.local_path = localPath;

      if (Object.keys(updates).length > 0) {
        updateProject(project.id, updates);
        console.log(`✅ Updated ${name}:`);
        for (const [k, v] of Object.entries(updates)) console.log(`   ${k}: ${v}`);
      } else {
        console.log(`ℹ️  ${name} already fully populated (use --force to overwrite).`);
      }

      // Sanity check before we enqueue: a clone needs both a github_url and
      // a target_path. If either is missing we'd kick off a job that fails
      // immediately with an unhelpful error.
      if (options.enqueueBootstrap) {
        const refreshed = getProjectByName(name);
        if (!refreshed.github_owner || !refreshed.github_repo) {
          console.error('❌ Cannot enqueue bootstrap_project — github_owner/github_repo missing.');
          process.exit(1);
        }
        if (!refreshed.local_path) {
          console.error('❌ Cannot enqueue bootstrap_project — local_path still null.');
          process.exit(1);
        }
        const githubUrl = `https://github.com/${refreshed.github_owner}/${refreshed.github_repo}.git`;
        const { getQueue, QUEUES } = await import('../../server/bullmq.js');
        const queue = getQueue(QUEUES.agents);
        const job = await queue.add('bootstrap_project', {
          agent: 'bootstrap',
          project_id: refreshed.id,
          github_url: githubUrl,
          target_path: refreshed.local_path
        }, { attempts: 2, backoff: { type: 'exponential', delay: 30_000 } });
        console.log(`📦 bootstrap_project job enqueued: ${job.id}`);
        console.log(`   git clone ${githubUrl} → ${refreshed.local_path}`);
      }
    } catch (error) {
      console.error('❌ Error linking project:', error.message);
      process.exit(1);
    }
  });

// Delete project
adminCommand
  .command('delete <name>')
  .description('Delete a project')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (name, options) => {
    try {
      initMasterDatabase(options.storage);

      const project = getProjectByName(name);

      if (!project) {
        console.error(`❌ Project "${name}" not found.`);
        process.exit(1);
      }

      if (!options.yes) {
        console.log(`⚠️  Are you sure you want to delete project "${name}"? (yes/no)`);
        console.log('   This will delete all tickets and data.');

        // In a real implementation, you'd use readline or prompts
        console.log('   Use --yes flag to confirm.');
        process.exit(1);
      }

      dbDeleteProject(project.id);

      console.log(`✅ Project "${name}" deleted successfully.`);

    } catch (error) {
      console.error('❌ Error deleting project:', error.message);
      process.exit(1);
    }
  });

export { adminCommand };
