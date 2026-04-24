#!/usr/bin/env node
// Live smoke test for plane_* attachment tools against real Plane.
// Requires: PLANE_API_KEY, PLANE_BASE_URL, PLANE_WORKSPACE_SLUG, and a
// work item ID passed as arg. Creates a tiny temp file, uploads it, lists,
// downloads, and prints a summary. Does NOT delete the attachment.
//
// Usage:
//   PLANE_API_KEY=... node scripts/_smoke-plane-attachments.js DEVPA-93

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listAttachments, uploadAttachment, downloadAttachment } from '../src/mcp/plane-attachments.js';

const [, , wi] = process.argv;
if (!wi) {
  console.error('usage: node scripts/_smoke-plane-attachments.js <DEVPA-xx | uuid>');
  process.exit(2);
}

async function main() {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'plane-smoke-'));
  // Use PLANE_INBOX_PATH override so we don't write to the real Shelly inbox.
  process.env.PLANE_INBOX_PATH = tmp;

  const sample = join(tmp, 'smoke.txt');
  await fs.writeFile(sample, `smoke test ${new Date().toISOString()}`);

  console.log(`[1/3] uploading ${sample} → ${wi}`);
  const up = await uploadAttachment(wi, sample, { name: 'smoke.txt', type: 'text/plain' });
  console.log('  →', up);

  console.log(`[2/3] listing attachments on ${wi}`);
  const list = await listAttachments(wi);
  console.log('  →', list.length, 'attachments; newest:', list.find(a => a.id === up.attachment_id) || list[0]);

  console.log(`[3/3] downloading ${up.attachment_id}`);
  const dl = await downloadAttachment(wi, up.attachment_id);
  console.log('  →', dl);
  const roundtrip = await fs.readFile(dl.path, 'utf8');
  console.log('  → content:', JSON.stringify(roundtrip));

  console.log('OK');
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });
