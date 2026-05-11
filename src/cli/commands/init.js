import { Command } from 'commander';
import { writeFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

export const initCommand = new Command('init')
  .description('Initialize dev-panel in current project')
  .option('-f, --force', 'Overwrite existing configuration')
  .action(async (options) => {
    const cwd = process.cwd();
    const configPath = join(cwd, '.devpanelrc.json');
    const storagePath = join(cwd, 'storage');
    const gitignorePath = join(cwd, '.gitignore');

    // Check if already initialized
    if (existsSync(configPath) && !options.force) {
      console.log('⚠️  DevPanel already initialized. Use --force to overwrite.');
      return;
    }

    // Detect project info from package.json
    let projectName = 'unknown';
    let githubOwner = '';
    let githubRepo = '';

    const packageJsonPath = join(cwd, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      projectName = packageJson.name || 'unknown';

      // Try to extract GitHub info from repository field
      if (packageJson.repository) {
        const repoUrl = typeof packageJson.repository === 'string'
          ? packageJson.repository
          : packageJson.repository.url;

        const match = repoUrl?.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        if (match) {
          githubOwner = match[1];
          githubRepo = match[2];
        }
      }
    }

    // Generate API key
    const apiKey = crypto.randomBytes(32).toString('hex');

    // Create config
    const config = {
      project: projectName,
      storage: {
        path: './storage',
        maxFileSize: '10MB'
      },
      server: {
        port: 3030,
        host: 'localhost',
        apiKey
      },
      github: {
        owner: githubOwner,
        repo: githubRepo,
        token: '${GITHUB_TOKEN}',
        labels: {
          bug: ['bug', 'needs-triage'],
          feature: ['enhancement', 'feature-request']
        }
      },
      sync: {
        enabled: true,
        interval: '15m'
      }
    };

    // Write config
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('✓ Created .devpanelrc.json');

    // Create storage directories
    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
      mkdirSync(join(storagePath, 'uploads'), { recursive: true });
      console.log('✓ Created storage/ directory');
    }

    // Update .gitignore
    if (existsSync(gitignorePath)) {
      let gitignore = readFileSync(gitignorePath, 'utf-8');
      if (!gitignore.includes('storage/')) {
        appendFileSync(gitignorePath, '\n# DevPanel\nstorage/\n');
        console.log('✓ Added storage/ to .gitignore');
      }
    } else {
      writeFileSync(gitignorePath, '# DevPanel\nstorage/\n');
      console.log('✓ Created .gitignore');
    }

    // Initialize database
    const { initMasterDatabase } = await import('../../server/db.js');
    initMasterDatabase(storagePath);
    console.log('✓ Initialized SQLite database (storage/projects.db)');

    console.log('\n✨ DevPanel initialized successfully!\n');
    console.log('Next steps:');
    console.log('  1. Set GITHUB_TOKEN in .env.local');
    console.log('  2. Update .devpanelrc.json with your GitHub repo info');
    console.log('  3. Add DevPanel to your React app (see README)');
    console.log('  4. Start server: npx dev-panel serve\n');
  });
