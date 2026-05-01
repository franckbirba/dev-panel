// Plane work-item attachments — list / download / upload.
//
// All traffic goes through the Plane public REST API (X-API-Key auth).
// We never touch MinIO/Postgres directly; Plane issues a presigned POST for
// upload and a 302 redirect to a presigned GET for download.
//
// Files downloaded for Shelly land in an inbox path she is allowed to Read
// (same directory used by the Telegram plugin for image drops).

import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';

const DEFAULT_INBOX = '/home/deploy/.claude/channels/telegram/inbox';
const SEQ_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXT_TO_MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain', md: 'text/markdown',
  json: 'text/plain',   // Plane rejects application/json — fall through as text
  csv: 'text/plain',
  yaml: 'text/plain', yml: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/x-m4a',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime'
};

function planeConfig() {
  const base = (process.env.PLANE_BASE_URL || 'https://plane.devpanl.dev').replace(/\/$/, '');
  const slug = process.env.PLANE_WORKSPACE_SLUG || 'devpanl';
  const key = process.env.PLANE_API_KEY || process.env.PLANE_API_TOKEN || '';
  if (!key) throw new Error('PLANE_API_KEY (or PLANE_API_TOKEN) is not configured');
  return { base, slug, key };
}

function headers(key) {
  return { 'X-API-Key': key, 'User-Agent': 'dev-panel/plane-attachments' };
}

// Resolve a DEVPA-93 sequence OR a bare UUID to {id, project_id, title}.
//
// For a sequence (e.g. EDMS-29) we hit the workspace-level identifier
// endpoint `/workspaces/<slug>/work-items/<IDENTIFIER>/`, which returns the
// issue including its `project` UUID in one round-trip. The legacy code
// path used `/projects/<P>/issues/?sequence=<N>` and trusted the filter,
// but Plane v1.3's IssueListEndpoint silently ignores that query param
// and returns the full project listing — `items[0]` then resolved to
// whichever sequence_id sorts first (typically the most recent issue),
// not the one we asked for. Downstream tools (listAttachments, etc.)
// would happily call into that wrong work item and report []. (DEVPA bug
// 14045855: plane_list_attachments returned [] on EDMS-29.)
//
// Bare UUIDs still need project_id resolution, so we keep the per-project
// probe for that path only.
export async function resolveWorkItem(idOrSeq, { base, slug, key }) {
  if (!idOrSeq) throw new Error('work_item_id is required');

  const seq = String(idOrSeq).match(SEQ_RE);
  if (seq) {
    const url = `${base}/api/v1/workspaces/${slug}/work-items/${idOrSeq}/`;
    const res = await fetch(url, { headers: headers(key), signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Work item ${idOrSeq} lookup failed: HTTP ${res.status} ${body}`);
    }
    const wi = await res.json();
    if (!wi || !wi.id || !wi.project) {
      throw new Error(`Work item ${idOrSeq} returned no id/project`);
    }
    return { id: wi.id, project_id: wi.project, title: wi.name };
  }

  if (!UUID_RE.test(idOrSeq)) {
    throw new Error(`"${idOrSeq}" is neither a UUID nor a sequence like DEVPA-93`);
  }

  const projRes = await fetch(
    `${base}/api/v1/workspaces/${slug}/projects/`,
    { headers: headers(key), signal: AbortSignal.timeout(5000) }
  );
  if (!projRes.ok) throw new Error(`Plane projects lookup failed: HTTP ${projRes.status}`);
  const projects = (await projRes.json()).results || [];
  for (const proj of projects) {
    const wiRes = await fetch(
      `${base}/api/v1/workspaces/${slug}/projects/${proj.id}/issues/${idOrSeq}/`,
      { headers: headers(key), signal: AbortSignal.timeout(5000) }
    );
    if (wiRes.ok) {
      const wi = await wiRes.json();
      return { id: wi.id, project_id: proj.id, title: wi.name };
    }
  }
  throw new Error(`Work item ${idOrSeq} not found in any project`);
}

export async function listAttachments(workItemId) {
  const cfg = planeConfig();
  const wi = await resolveWorkItem(workItemId, cfg);
  const url = `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${wi.project_id}/work-items/${wi.id}/attachments/`;
  const res = await fetch(url, { headers: headers(cfg.key), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`List attachments failed: HTTP ${res.status} ${await res.text()}`);
  const raw = await res.json();
  const rows = raw.results || raw;
  return rows.map(r => ({
    id: r.id,
    name: r.attributes?.name || r.name,
    type: r.attributes?.type || r.type,
    size: r.attributes?.size || r.size,
    is_uploaded: r.is_uploaded,
    created_at: r.created_at,
    work_item_id: wi.id,
    project_id: wi.project_id
  }));
}

export async function downloadAttachment(workItemId, attachmentId, opts = {}) {
  const cfg = planeConfig();
  const wi = await resolveWorkItem(workItemId, cfg);
  const inbox = opts.inbox || process.env.PLANE_INBOX_PATH || DEFAULT_INBOX;
  await fs.mkdir(inbox, { recursive: true });

  // GET .../attachments/<pk>/ returns 302 → presigned MinIO URL.
  // fetch() auto-follows redirects by default, so we get the file body directly.
  const url = `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${wi.project_id}/work-items/${wi.id}/attachments/${attachmentId}/`;
  const res = await fetch(url, { headers: headers(cfg.key), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);

  // Discover the filename — prefer the attachments list (name lives in attributes).
  const list = await listAttachments(workItemId);
  const meta = list.find(a => a.id === attachmentId);
  const safeName = (meta?.name || `${attachmentId}.bin`).replace(/[^\w.\-]/g, '_');
  const path = join(inbox, `plane-${attachmentId}-${safeName}`);

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(path, buf);
  return {
    path,
    name: meta?.name || safeName,
    type: meta?.type || res.headers.get('content-type'),
    size: buf.length,
    attachment_id: attachmentId,
    work_item_id: wi.id
  };
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return EXT_TO_MIME[ext] || 'text/plain';
}

export async function uploadAttachment(workItemId, filePath, opts = {}) {
  const cfg = planeConfig();
  const wi = await resolveWorkItem(workItemId, cfg);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`${filePath} is not a regular file`);
  const name = opts.name || basename(filePath);
  const type = opts.type || guessMime(name);
  const size = stat.size;

  // Step 1 — ask Plane for a presigned POST.
  const createUrl = `${cfg.base}/api/v1/workspaces/${cfg.slug}/projects/${wi.project_id}/work-items/${wi.id}/attachments/`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: { ...headers(cfg.key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, size, external_id: opts.external_id, external_source: opts.external_source }),
    signal: AbortSignal.timeout(10000)
  });
  if (!createRes.ok) throw new Error(`Create attachment failed: HTTP ${createRes.status} ${await createRes.text()}`);
  const { upload_data, asset_id } = await createRes.json();
  if (!upload_data?.url) throw new Error('Plane returned no upload_data.url');

  // Step 2 — multipart POST to MinIO/S3 with the presigned fields.
  const form = new FormData();
  for (const [k, v] of Object.entries(upload_data.fields || {})) form.append(k, v);
  const fileBuf = await fs.readFile(filePath);
  form.append('file', new Blob([fileBuf], { type }), name);
  const uploadRes = await fetch(upload_data.url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60000)
  });
  if (!(uploadRes.ok || uploadRes.status === 204)) {
    throw new Error(`S3 upload failed: HTTP ${uploadRes.status} ${await uploadRes.text().catch(() => '')}`);
  }

  // Step 3 — confirm the upload so Plane marks is_uploaded=true.
  const patchUrl = `${createUrl}${asset_id}/`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { ...headers(cfg.key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_uploaded: true }),
    signal: AbortSignal.timeout(10000)
  });
  if (!(patchRes.ok || patchRes.status === 204)) {
    throw new Error(`Confirm upload failed: HTTP ${patchRes.status} ${await patchRes.text().catch(() => '')}`);
  }

  return { attachment_id: asset_id, name, type, size, work_item_id: wi.id, project_id: wi.project_id };
}

// Exposed for tests — lets you swap network + fs with stubs.
export const __internal = { guessMime, EXT_TO_MIME, SEQ_RE, UUID_RE, DEFAULT_INBOX };

// Convenience: inbox path generator (re-exported for tools that want to
// predict the final path without running the download).
export function inboxPathFor(attachmentId, name, inbox = DEFAULT_INBOX) {
  const safeName = (name || `${attachmentId}.bin`).replace(/[^\w.\-]/g, '_');
  return join(inbox, `plane-${attachmentId}-${safeName}`);
}

// Token helpers for caller-side branding; keeps short name for the trace logs.
export function randomRequestId() { return randomUUID().slice(0, 8); }
