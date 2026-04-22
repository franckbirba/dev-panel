// tests/server/widget-route.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

// This test exercises the /widget.js Express route. The route should
// (a) respond 200, (b) set Cache-Control: public, max-age=300, (c) send
// the contents of dist/widget.js. We stub a fake dist/widget.js in a
// temp location and point the test server at it via the real app —
// since the app reads dist/ relative to src/server/, we just ensure a
// dist/widget.js exists at the expected path for this test run.

describe('GET /widget.js', () => {
  let app;
  beforeEach(async () => {
    // The widget route reads from ../../dist/widget.js relative to
    // src/server/index.js. Make sure that file exists for this test.
    const distDir = join(process.cwd(), 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'widget.js'), '/* test widget bundle */\n');

    const storage = mkdtempSync(join(tmpdir(), 'devpanel-widget-'));
    const { createServer } = await import('../../src/server/index.js');
    ({ app } = createServer(storage));
  });

  it('returns the widget bundle', async () => {
    const r = await request(app).get('/widget.js');
    expect(r.status).toBe(200);
    expect(r.text).toContain('test widget bundle');
  });

  it('sets a 5-minute public Cache-Control', async () => {
    const r = await request(app).get('/widget.js');
    expect(r.headers['cache-control']).toContain('public');
    expect(r.headers['cache-control']).toContain('max-age=300');
  });

  it('serves with Content-Type: application/javascript', async () => {
    const r = await request(app).get('/widget.js');
    expect(r.headers['content-type']).toMatch(/javascript/);
  });
});
