import { Command } from 'commander';
import {
  initMasterDatabase,
  createProject,
  getProjectByName,
  initProjectDatabase,
  createTicket,
  upsertMilestone
} from '../../server/db.js';
import { initGitHub, listIssues, fetchMilestones } from '../../server/github.js';

const importCommand = new Command('import')
  .description('Import a GitHub repository as a dev-panel project')
  .argument('<github-url>', 'GitHub repository URL (e.g. https://github.com/owner/repo)')
  .option('-t, --token <token>', 'GitHub token (or use GITHUB_TOKEN env var)')
  .option('-s, --storage <path>', 'Storage path', './storage')
  .action(async (githubUrl, options) => {
    try {
      // Parse GitHub URL
      const parsed = parseGitHubUrl(githubUrl);
      if (!parsed) {
        console.error('❌ Invalid GitHub URL. Expected: https://github.com/owner/repo');
        process.exit(1);
      }

      const { owner, repo } = parsed;
      const githubToken = options.token || process.env.GITHUB_TOKEN;

      if (!githubToken) {
        console.error('❌ GitHub token required. Provide via --token or GITHUB_TOKEN env var.');
        process.exit(1);
      }

      // Initialize
      initMasterDatabase(options.storage);
      initGitHub(githubToken);

      // Check if project already exists
      const existing = getProjectByName(repo);
      if (existing) {
        console.error(`❌ Project "${repo}" already exists (ID: ${existing.id})`);
        process.exit(1);
      }

      console.log(`\n🔍 Importing ${owner}/${repo}...\n`);

      // Create project in DB
      const project = createProject({
        name: repo,
        github_owner: owner,
        github_repo: repo,
        github_token: githubToken
      });

      console.log(`✅ Project created: ${project.name} (${project.id})`);

      // Initialize project database
      initProjectDatabase(options.storage, project.id);

      // Import open issues as tickets
      console.log('📥 Fetching open issues...');
      const issues = await listIssues({ owner, repo, state: 'open' });

      // Filter out pull requests (GitHub API returns PRs as issues)
      const realIssues = issues.filter(i => !i.pull_request);

      let imported = 0;
      for (const issue of realIssues) {
        const type = issue.labels.some(l =>
          ['bug', 'fix', 'defect'].includes(l.name.toLowerCase())
        ) ? 'bug' : 'feature';

        createTicket(options.storage, project.id, {
          type,
          title: issue.title,
          description: issue.body || '(no description)',
          context: {
            github_url: issue.html_url,
            labels: issue.labels.map(l => l.name),
            author: issue.user?.login
          },
          created_by: issue.user?.login
        });

        // Link back to GitHub
        const db = (await import('../../server/db.js')).getProjectDatabase(options.storage, project.id);
        const lastId = db.prepare('SELECT MAX(id) as id FROM tickets').get().id;
        db.prepare(`
          UPDATE tickets SET
            github_issue_number = ?,
            github_issue_url = ?,
            github_status = ?,
            status = 'published'
          WHERE id = ?
        `).run(issue.number, issue.html_url, issue.state, lastId);

        imported++;
      }

      console.log(`📥 ${imported} issues imported`);

      // Fetch and store milestones
      console.log('📥 Fetching milestones...');
      const milestones = await fetchMilestones({ owner, repo });
      for (const m of milestones) {
        upsertMilestone(options.storage, project.id, m);
      }
      console.log(`📥 ${milestones.length} milestones imported`);

      // Fetch markdown docs
      console.log('📥 Fetching documentation...');
      try {
        const { data: tree } = await octokit.rest.git.getTree({
          owner, repo, tree_sha: 'HEAD', recursive: '1'
        });

        const mdFiles = tree.tree.filter(f =>
          f.type === 'blob' && f.path.endsWith('.md')
        );

        console.log(`📄 ${mdFiles.length} markdown files found`);
      } catch (e) {
        console.log('⚠️  Could not fetch docs (empty repo?)');
      }

      // Summary
      console.log('\n' + '━'.repeat(60));
      console.log('✅ Import complete!\n');
      console.log(`Project:    ${project.name}`);
      console.log(`ID:         ${project.id}`);
      console.log(`API Key:    ${project.api_key}`);
      console.log(`GitHub:     ${owner}/${repo}`);
      console.log(`Issues:     ${imported}`);
      console.log('━'.repeat(60));
      console.log('\nAdd to your app:');
      console.log(`  DEV_PANEL_URL=http://localhost:3030`);
      console.log(`  DEV_PANEL_API_KEY=${project.api_key}\n`);

    } catch (error) {
      console.error('❌ Import failed:', error.message);
      process.exit(1);
    }
  });

function parseGitHubUrl(url) {
  // Support: https://github.com/owner/repo, github.com/owner/repo, owner/repo
  const patterns = [
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/\s#?.]+)/,
    /^([^/\s]+)\/([^/\s]+)$/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    }
  }

  return null;
}

export { importCommand };
