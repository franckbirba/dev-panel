import { Command } from 'commander';
import { join } from 'path';
import { readFileSync } from 'fs';
import {
  initMasterDatabase,
  createProject,
  listProjects,
  getProjectByName,
  getProjectById,
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
