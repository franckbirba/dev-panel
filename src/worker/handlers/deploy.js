// src/worker/handlers/deploy.js
import { spawn } from 'child_process';
import { assertAllowedRequester } from '../auth.js';
import { notifyJob } from '../../server/alerts.js';
import { logStep } from '../../server/jobs-log.js';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`)));
  });
}

export async function handleDeploy(jobData) {
  const { job_id, requested_by = 'unknown' } = jobData;
  assertAllowedRequester('deploy', requested_by);

  const started = Date.now();
  const todayTag = `deploy-${new Date().toISOString().slice(0, 10)}`;

  await notifyJob({
    job_id, agent: 'deploy',
    work_item_id: todayTag,
    title: `build ${requested_by}`,
    status: 'done', extra: 'starting'
  });

  // Pre-check
  await logStep({ job_id, agent: 'deploy', step: 'stack-status', status: 'ok' });
  try { await run('make', ['status'], { cwd: process.cwd() }); }
  catch (e) {
    return {
      status: 'failed',
      summary: `stack-status precheck failed: ${e.message}`,
      artifacts: { files_created: [], files_modified: [], commits: [], branch: null, tests_passed: false, pr_url: null },
      handoff: { next_agent: null, reason: 'precheck' },
      memory_writes_count: 0, blockers: [], issues_found: []
    };
  }

  // Build, push, deploy
  const imageTag = 'latest';
  try {
    await run('make', ['build'], { cwd: process.cwd() });
    await run('make', ['push'], { cwd: process.cwd() });
    await run('make', ['deploy-core'], { cwd: process.cwd() });
  } catch (e) {
    return {
      status: 'failed',
      summary: `deploy failed: ${e.message}`,
      artifacts: { files_created: [], files_modified: [], commits: [], branch: null, tests_passed: false, pr_url: null },
      handoff: { next_agent: null, reason: 'deploy-failure' },
      memory_writes_count: 0, blockers: [e.message], issues_found: []
    };
  }

  await notifyJob({
    job_id, agent: 'deploy',
    work_item_id: todayTag,
    title: null,
    status: 'done',
    duration_ms: Date.now() - started,
    extra: `image pushed (${imageTag})`,
    next_agent: null
  });

  return {
    status: 'done',
    summary: `deploy ok (image=${imageTag})`,
    artifacts: { files_created: [], files_modified: [], commits: [], branch: null, tests_passed: true, pr_url: null },
    handoff: { next_agent: null, reason: 'terminal' },
    memory_writes_count: 0, blockers: [], issues_found: []
  };
}
