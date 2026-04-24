import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ORIGINAL_ENV = { ...process.env };

// The module reads env at call time, so we can just rewrite process.env
// before importing. Inbox is redirected to a tmp dir so we never touch the
// real /home/deploy path.
let tmpInbox;

beforeEach(async () => {
  tmpInbox = await fs.mkdtemp(join(tmpdir(), 'plane-attach-'));
  process.env = {
    ...ORIGINAL_ENV,
    PLANE_BASE_URL: 'https://plane.test',
    PLANE_WORKSPACE_SLUG: 'devpanl',
    PLANE_API_KEY: 'test-key',
    PLANE_INBOX_PATH: tmpInbox
  };
  vi.resetModules();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  await fs.rm(tmpInbox, { recursive: true, force: true });
});

describe('plane-attachments — guessMime', () => {
  it('maps common extensions', async () => {
    const mod = await import('../../src/mcp/plane-attachments.js');
    const { __internal } = mod;
    expect(__internal.EXT_TO_MIME.pdf).toBe('application/pdf');
    expect(__internal.EXT_TO_MIME.xlsx).toMatch(/spreadsheetml/);
    expect(__internal.EXT_TO_MIME.json).toBe('text/plain');
    expect(__internal.guessMime('report.xlsx')).toMatch(/spreadsheetml/);
    expect(__internal.guessMime('notes.unknown')).toBe('text/plain');
  });
});

describe('plane-attachments — inboxPathFor', () => {
  it('sanitizes filenames and prefixes with attachment id', async () => {
    const { inboxPathFor } = await import('../../src/mcp/plane-attachments.js');
    const p = inboxPathFor('abc-123', 'hello world / v1.pdf', '/tmp/inbox');
    expect(p).toBe('/tmp/inbox/plane-abc-123-hello_world___v1.pdf');
  });
});

describe('plane-attachments — listAttachments', () => {
  it('resolves DEVPA-93 and lists attachments', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url);
      if (url.includes('/projects/') && url.endsWith('/projects/')) {
        return new Response(JSON.stringify({ results: [{ id: 'proj-uuid', identifier: 'DEVPA' }] }), { status: 200 });
      }
      if (url.includes('?sequence=93')) {
        return new Response(JSON.stringify({ results: [{ id: 'wi-uuid', name: 'hello' }] }), { status: 200 });
      }
      if (url.endsWith('/attachments/')) {
        return new Response(JSON.stringify({ results: [
          { id: 'att-1', attributes: { name: 'a.pdf', type: 'application/pdf', size: 1234 }, is_uploaded: true, created_at: '2026-04-24T00:00:00Z' }
        ] }), { status: 200 });
      }
      throw new Error('unexpected url ' + url);
    });
    const { listAttachments } = await import('../../src/mcp/plane-attachments.js');
    const rows = await listAttachments('DEVPA-93');
    expect(rows).toEqual([
      expect.objectContaining({ id: 'att-1', name: 'a.pdf', type: 'application/pdf', size: 1234, work_item_id: 'wi-uuid', project_id: 'proj-uuid' })
    ]);
    expect(calls.some(u => u.includes('/projects/proj-uuid/work-items/wi-uuid/attachments/'))).toBe(true);
  });

  it('fails when the sequence has no matching project', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: 'p', identifier: 'OTHER' }] }), { status: 200 }));
    const { listAttachments } = await import('../../src/mcp/plane-attachments.js');
    await expect(listAttachments('DEVPA-99')).rejects.toThrow(/identifier "DEVPA"/);
  });

  it('fails when PLANE_API_KEY is missing', async () => {
    delete process.env.PLANE_API_KEY;
    delete process.env.PLANE_API_TOKEN;
    const { listAttachments } = await import('../../src/mcp/plane-attachments.js');
    await expect(listAttachments('DEVPA-1')).rejects.toThrow(/PLANE_API_KEY/);
  });
});

describe('plane-attachments — uploadAttachment', () => {
  it('runs the 3-step presigned dance', async () => {
    const tmpFile = join(tmpInbox, 'sample.pdf');
    await fs.writeFile(tmpFile, Buffer.from('%PDF-1.4 fake'));

    let createBody;
    let s3Hit = false;
    let patchBody;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      if (url.endsWith('/projects/')) {
        return new Response(JSON.stringify({ results: [{ id: 'proj-uuid', identifier: 'DEVPA' }] }), { status: 200 });
      }
      if (url.includes('?sequence=93')) {
        return new Response(JSON.stringify({ results: [{ id: 'wi-uuid', name: 'hello' }] }), { status: 200 });
      }
      if (url.endsWith('/attachments/') && opts.method === 'POST') {
        createBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          upload_data: { url: 'https://s3.test/bucket', fields: { key: 'workspace/abc-sample.pdf', policy: 'x' } },
          asset_id: 'att-42',
          attachment: { id: 'att-42' }
        }), { status: 200 });
      }
      if (url === 'https://s3.test/bucket') {
        s3Hit = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/att-42/') && opts.method === 'PATCH') {
        patchBody = JSON.parse(opts.body);
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected url ' + url + ' method=' + opts.method);
    });

    const { uploadAttachment } = await import('../../src/mcp/plane-attachments.js');
    const out = await uploadAttachment('DEVPA-93', tmpFile);
    expect(out).toMatchObject({ attachment_id: 'att-42', name: 'sample.pdf', type: 'application/pdf', work_item_id: 'wi-uuid' });
    expect(createBody).toMatchObject({ name: 'sample.pdf', type: 'application/pdf', size: 13 });
    expect(s3Hit).toBe(true);
    expect(patchBody).toEqual({ is_uploaded: true });
  });

  it('overrides name and type', async () => {
    const tmpFile = join(tmpInbox, 'raw.bin');
    await fs.writeFile(tmpFile, Buffer.from('hello'));
    let createBody;
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      if (url.endsWith('/projects/')) return new Response(JSON.stringify({ results: [{ id: 'p', identifier: 'DEVPA' }] }), { status: 200 });
      if (url.includes('?sequence=1')) return new Response(JSON.stringify({ results: [{ id: 'w', name: 't' }] }), { status: 200 });
      if (url.endsWith('/attachments/') && opts.method === 'POST') {
        createBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({ upload_data: { url: 'https://s3.test/b', fields: {} }, asset_id: 'x' }), { status: 200 });
      }
      if (url === 'https://s3.test/b') return new Response(null, { status: 204 });
      if (url.endsWith('/x/')) return new Response(null, { status: 204 });
      throw new Error('unexpected ' + url);
    });
    const { uploadAttachment } = await import('../../src/mcp/plane-attachments.js');
    await uploadAttachment('DEVPA-1', tmpFile, { name: 'renamed.pdf', type: 'application/pdf' });
    expect(createBody).toMatchObject({ name: 'renamed.pdf', type: 'application/pdf' });
  });
});

describe('plane-attachments — downloadAttachment', () => {
  it('writes file to inbox with safe name and returns metadata', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith('/projects/')) return new Response(JSON.stringify({ results: [{ id: 'p', identifier: 'DEVPA' }] }), { status: 200 });
      if (url.includes('?sequence=7')) return new Response(JSON.stringify({ results: [{ id: 'w', name: 't' }] }), { status: 200 });
      if (url.endsWith('/att-9/')) {
        return new Response(Buffer.from('file-bytes'), {
          status: 200,
          headers: { 'content-type': 'application/pdf' }
        });
      }
      if (url.endsWith('/attachments/')) {
        return new Response(JSON.stringify({ results: [
          { id: 'att-9', attributes: { name: 'weird name/ok.pdf', type: 'application/pdf', size: 10 } }
        ] }), { status: 200 });
      }
      throw new Error('unexpected ' + url);
    });
    const { downloadAttachment } = await import('../../src/mcp/plane-attachments.js');
    const out = await downloadAttachment('DEVPA-7', 'att-9');
    expect(out.path).toMatch(/plane-att-9-weird_name_ok\.pdf$/);
    expect(out.size).toBe(10);
    const disk = await fs.readFile(out.path);
    expect(disk.toString()).toBe('file-bytes');
  });
});
