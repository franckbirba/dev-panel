import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('notifyJob writes deploy_events for deploy agent', () => {
  let project, listRecentDeploys, notifyJob;
  beforeEach(async () => {
    vi.resetModules();
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-alrt-'));
    const db = await import('../../src/server/db.js');
    db.initMasterDatabase(tmp);
    project = db.createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    const de = await import('../../src/server/deploy-events.js');
    listRecentDeploys = de.listRecentDeploys;
    process.env.SHELLY_TELEGRAM_WEBHOOK = 'https://webhook.test/hook';
    process.env.SHELLY_DEBOUNCE_MS = '0';
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const alerts = await import('../../src/server/alerts.js');
    notifyJob = alerts.notifyJob;
  });

  it('records a deploy_succeeded event when agent=deploy + status=done', async () => {
    await notifyJob({
      job_id: 'job_1', agent: 'deploy', work_item_id: project.id,
      title: 'release v2', status: 'done', extra: 'sha=abc1234', duration_ms: 4000
    });
    await new Promise(r => setTimeout(r, 30));
    const events = listRecentDeploys(project.id);
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('succeeded');
    expect(events[0].sha).toBe('abc1234');
  });

  it('records a deploy_failed event when agent=deploy + status=failed', async () => {
    await notifyJob({
      job_id: 'job_2', agent: 'deploy', work_item_id: project.id,
      title: 'release v2', status: 'failed', extra: 'lint failure'
    });
    await new Promise(r => setTimeout(r, 30));
    const events = listRecentDeploys(project.id);
    expect(events[0].status).toBe('failed');
    expect(events[0].failed_reason).toBe('lint failure');
  });

  it('does not record for non-deploy agents', async () => {
    await notifyJob({
      job_id: 'job_3', agent: 'builder', work_item_id: project.id,
      title: 't', status: 'done'
    });
    await new Promise(r => setTimeout(r, 30));
    expect(listRecentDeploys(project.id)).toHaveLength(0);
  });
});
