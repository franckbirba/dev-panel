// Read/write infra/config/oauth2-proxy-emails.txt via the GitHub Contents API.
// Adding/removing an invitee => commit on main => CI runs render-whitelist.sh
// + refreshes the oauth2-proxy container. Live within ~30s.
//
// Why GitHub-as-storage instead of a sqlite table: the .txt file is the
// source of truth read by the deploy pipeline; storing it elsewhere would
// drift. Using the Contents API also means no docker.sock or SSH from the
// devpanel-api container.
import { Octokit } from 'octokit';

const REPO_OWNER = 'franckbirba';
const REPO_NAME = 'dev-panel';
const FILE_PATH = 'infra/config/oauth2-proxy-emails.txt';
const BRANCH = 'main';

// Lightweight email check — same shape thomseddon's WHITELIST accepts.
// Strict enough to reject typos like "alice gmail.com" but not RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function client() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not configured');
  return new Octokit({ auth: token });
}

function parseFileContent(b64) {
  const text = Buffer.from(b64, 'base64').toString('utf8');
  const emails = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    emails.push(line);
  }
  return { text, emails };
}

function renderFile(emails) {
  const header =
    '# Allowlist for traefik-forward-auth (oauth-google@docker middleware).\n' +
    '# One email per line. `#` starts a comment. Edit via the dashboard at\n' +
    '# https://devpanl.dev/dashboard/settings — the change goes live after CI\n' +
    '# refreshes oauth2-proxy (~30s).\n';
  return header + emails.join('\n') + '\n';
}

async function fetchFile() {
  const { data } = await client().rest.repos.getContent({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: FILE_PATH,
    ref: BRANCH
  });
  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${FILE_PATH} is not a file`);
  }
  const { emails } = parseFileContent(data.content);
  return { emails, sha: data.sha };
}

async function commitFile({ emails, sha, message }) {
  const content = Buffer.from(renderFile(emails), 'utf8').toString('base64');
  await client().rest.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: FILE_PATH,
    branch: BRANCH,
    message,
    content,
    sha
  });
}

export async function listAllowlist() {
  const { emails } = await fetchFile();
  return emails;
}

export async function addEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) {
    const err = new Error('invalid email');
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  const { emails, sha } = await fetchFile();
  if (emails.map(e => e.toLowerCase()).includes(clean)) {
    return { emails, alreadyPresent: true };
  }
  const next = [...emails, clean];
  await commitFile({
    emails: next,
    sha,
    message: `chore(allowlist): invite ${clean}`
  });
  return { emails: next, alreadyPresent: false };
}

export async function removeEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) {
    const err = new Error('email required');
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  const { emails, sha } = await fetchFile();
  const next = emails.filter(e => e.toLowerCase() !== clean);
  if (next.length === emails.length) {
    return { emails, removed: false };
  }
  if (next.length === 0) {
    // Don't lock everyone out — render-whitelist.sh would abort anyway.
    const err = new Error('cannot remove the last email');
    err.code = 'WOULD_EMPTY_ALLOWLIST';
    throw err;
  }
  await commitFile({
    emails: next,
    sha,
    message: `chore(allowlist): remove ${clean}`
  });
  return { emails: next, removed: true };
}
