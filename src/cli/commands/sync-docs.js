import { Command } from 'commander';
import {
  initMasterDatabase,
  getProjectByName,
  getProjectById,
  listProjects,
  initProjectDatabase,
  upsertDoc,
  listDocs,
  deleteDoc,
  getDocStats
} from '../../server/db.js';
import { initGitHub, fetchRepoDocs } from '../../server/github.js';

const syncDocsCommand = new Command('sync-docs')
  .description('Sync markdown documentation from GitHub repos')
  .argument('[project]', 'Project name (syncs all if omitted)')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .action(async (projectName, options) => {
    try {
      initMasterDatabase(options.storage);

      let projects;
      if (projectName) {
        const project = getProjectByName(projectName);
        if (!project) {
          console.error(`❌ Project "${projectName}" not found.`);
          process.exit(1);
        }
        projects = [project];
      } else {
        projects = listProjects();
      }

      if (projects.length === 0) {
        console.log('No projects found.');
        return;
      }

      for (const project of projects) {
        console.log(`\n📄 Syncing docs for ${project.name} (${project.github_owner}/${project.github_repo})...`);

        if (!project.github_token) {
          console.log('  ⚠️  No GitHub token, skipping.');
          continue;
        }

        initGitHub(project.github_token);
        initProjectDatabase(options.storage, project.id);

        // Get existing docs for incremental sync
        const existingDocs = listDocs(options.storage, project.id);
        const existingShas = new Map(existingDocs.map(d => [d.path, d.sha]));

        // Fetch docs from GitHub
        let remoteDocs;
        try {
          remoteDocs = await fetchRepoDocs({
            owner: project.github_owner,
            repo: project.github_repo
          });
        } catch (e) {
          console.log(`  ⚠️  Could not fetch docs: ${e.message}`);
          continue;
        }

        const remotePaths = new Set(remoteDocs.map(d => d.path));
        let added = 0, updated = 0, removed = 0, skipped = 0;

        // Upsert docs
        for (const doc of remoteDocs) {
          if (existingShas.get(doc.path) === doc.sha) {
            skipped++;
            continue;
          }

          upsertDoc(options.storage, project.id, doc);

          if (existingShas.has(doc.path)) {
            updated++;
          } else {
            added++;
          }
        }

        // Remove docs that no longer exist in repo
        for (const existing of existingDocs) {
          if (!remotePaths.has(existing.path)) {
            deleteDoc(options.storage, project.id, existing.path);
            removed++;
          }
        }

        const stats = getDocStats(options.storage, project.id);
        console.log(`  ✅ +${added} added, ~${updated} updated, -${removed} removed, =${skipped} unchanged`);
        console.log(`  📚 Total: ${stats.count} docs indexed`);
      }

      console.log('\n✅ Docs sync complete.\n');

    } catch (error) {
      console.error('❌ Sync docs failed:', error.message);
      process.exit(1);
    }
  });

export { syncDocsCommand };
