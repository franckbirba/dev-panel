import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, getProjectByName } from '../../src/server/db.js';

vi.mock('../../src/server/bullmq.js', () => ({
  getQueue: () => ({ add: vi.fn().mockResolvedValue({ id: 'job_boot_1' }) }),
  QUEUES: { agent: 'agent' }
}));

import { bootstrapFromGithub, parseGithubUrl } from '../../src/server/projects-bootstrap.js';

describe('parseGithubUrl', () => {
  it('handles https url', () => {
    expect(parseGithubUrl('https://github.com/franck/zeno')).toEqual({ owner: 'franck', repo: 'zeno' });
  });
  it('handles https url with .git suffix', () => {
    expect(parseGithubUrl('https://github.com/franck/zeno.git')).toEqual({ owner: 'franck', repo: 'zeno' });
  });
  it('handles ssh url', () => {
    expect(parseGithubUrl('git@github.com:franck/zeno.git')).toEqual({ owner: 'franck', repo: 'zeno' });
  });
  it('handles owner/repo shorthand', () => {
    expect(parseGithubUrl('franck/zeno')).toEqual({ owner: 'franck', repo: 'zeno' });
  });
  it('throws on garbage', () => {
    expect(() => parseGithubUrl('not a url')).toThrow(/invalid github/i);
  });
});

describe('bootstrapFromGithub', () => {
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-bs-'));
    initMasterDatabase(tmp);
    process.env.PLANE_API_BASE = 'https://plane.test';
    process.env.PLANE_WORKSPACE_SLUG = 'devpanl';
    process.env.PLANE_API_TOKEN = 'plane_tok';
    process.env.GITHUB_TOKEN = 'gh_tok';
    process.env.AGENTS_HOST_PROJECTS_PATH = '/home/deploy/projects';
  });

  it('happy path: probes GitHub, creates Plane project, mints key, enqueues clone', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.includes('api.github.com/repos/franck/zeno')) {
        return { ok: true, status: 200, json: async () => ({
          name: 'zeno', description: 'zen', default_branch: 'main', language: 'TypeScript'
        }) };
      }
      if (url.includes('plane.test')) {
        return { ok: true, status: 201, json: async () => ({ id: 'plane-uuid-123' }) };
      }
      throw new Error('unexpected fetch ' + url);
    });

    const result = await bootstrapFromGithub({ github_url: 'https://github.com/franck/zeno' });
    expect(result.project.name).toBe('zeno');
    expect(result.project.plane_project_id).toBe('plane-uuid-123');
    expect(result.project.github_owner).toBe('franck');
    expect(result.project.local_path).toBe('/home/deploy/projects/zeno');
    expect(result.bootstrap_job_id).toBe('job_boot_1');
    expect(getProjectByName('zeno')).toBeTruthy();
  });

  it('aborts before any DB write when GitHub probe fails', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }));
    await expect(bootstrapFromGithub({ github_url: 'https://github.com/franck/missing' }))
      .rejects.toThrow(/github.*not found/i);
    expect(getProjectByName('missing')).toBeFalsy();
  });

  it('aborts before mint when Plane create fails', async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.includes('api.github.com')) {
        return { ok: true, status: 200, json: async () => ({ name: 'edms', default_branch: 'main' }) };
      }
      if (url.includes('plane.test')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
    });
    await expect(bootstrapFromGithub({ github_url: 'franck/edms' })).rejects.toThrow(/plane/i);
    expect(getProjectByName('edms')).toBeFalsy();
  });
});
