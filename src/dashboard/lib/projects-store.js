// src/dashboard/lib/projects-store.js
//
// localStorage v2 schema for multi-project dashboard.
//
// v1 (legacy):  { devpanel_api_key: "<single string>" }
// v2 (current): {
//   devpanel_projects: { "<project_id>": { id, name, api_key, github_repo? } },
//   devpanel_current_project: "<project_id>",
//   devpanel_admin_key: "<optional admin key for cross-project ops>"
// }
//
// Migration runs once on first load: if v1 exists and v2 doesn't, promote
// the single key into a v2 entry under id "_legacy". The next /whoami call
// resolves the real id+name and rewrites the entry.

const K_PROJECTS = 'devpanel_projects';
const K_CURRENT  = 'devpanel_current_project';
const K_ADMIN    = 'devpanel_admin_key';
const K_LEGACY   = 'devpanel_api_key';

function readProjects() {
  try {
    const raw = localStorage.getItem(K_PROJECTS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

function writeProjects(map) {
  localStorage.setItem(K_PROJECTS, JSON.stringify(map));
}

export function migrateLegacy() {
  const v2 = readProjects();
  if (Object.keys(v2).length > 0) return; // already v2
  const legacy = localStorage.getItem(K_LEGACY);
  if (!legacy) return;
  v2['_legacy'] = { id: '_legacy', name: 'project', api_key: legacy };
  writeProjects(v2);
  if (!localStorage.getItem(K_CURRENT)) localStorage.setItem(K_CURRENT, '_legacy');
}

export function listLocalProjects() {
  return Object.values(readProjects()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function getCurrentProjectId() {
  const id = localStorage.getItem(K_CURRENT);
  if (!id) return null;
  const p = readProjects()[id];
  return p ? id : null;
}

export function getCurrentProject() {
  const id = getCurrentProjectId();
  if (!id) return null;
  return readProjects()[id] || null;
}

export function setCurrentProject(id) {
  if (!readProjects()[id]) throw new Error(`unknown project id: ${id}`);
  localStorage.setItem(K_CURRENT, id);
}

export function addOrUpdateProject(project) {
  if (!project?.id || !project?.api_key) {
    throw new Error('project requires id + api_key');
  }
  const map = readProjects();
  map[project.id] = {
    id: project.id,
    name: project.name || 'unnamed',
    api_key: project.api_key,
    github_repo: project.github_repo || null,
    plane_project_id: project.plane_project_id || null
  };
  writeProjects(map);
  // Drop the legacy placeholder once a real entry lands.
  if (map['_legacy'] && project.id !== '_legacy') {
    delete map['_legacy'];
    writeProjects(map);
  }
  if (!getCurrentProjectId()) setCurrentProject(project.id);
}

export function removeProject(id) {
  const map = readProjects();
  delete map[id];
  writeProjects(map);
  if (getCurrentProjectId() === id) {
    const remaining = Object.keys(map);
    if (remaining.length) setCurrentProject(remaining[0]);
    else localStorage.removeItem(K_CURRENT);
  }
}

export function getAdminKey() { return localStorage.getItem(K_ADMIN) || ''; }
export function setAdminKey(k) {
  if (k) localStorage.setItem(K_ADMIN, k);
  else localStorage.removeItem(K_ADMIN);
}

export function clearAll() {
  localStorage.removeItem(K_PROJECTS);
  localStorage.removeItem(K_CURRENT);
  localStorage.removeItem(K_ADMIN);
  localStorage.removeItem(K_LEGACY);
}

// Resolve a pasted api key to a full project record via /api/whoami,
// then store it. Returns the new project entry.
export async function importByApiKey(apiUrl, apiKey) {
  const res = await fetch(`${apiUrl}/api/whoami`, {
    headers: { 'X-API-Key': apiKey }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `whoami HTTP ${res.status}`);
  }
  const body = await res.json();
  const entry = {
    id: body.id, name: body.name, api_key: apiKey,
    github_repo: body.github_repo,
    plane_project_id: body.plane_project_id
  };
  addOrUpdateProject(entry);
  return entry;
}

// Hydrate the local project store from the server using the cookie session.
// Called once after login on a fresh browser so the user gets all their
// projects without having to paste keys again. Returns the number of
// projects synced (or 0 if the request failed / not authorized).
export async function hydrateFromSession(apiUrl) {
  try {
    // Traefik SSO injects X-Forwarded-User; no cookie needed (the
    // _forward_auth cookie is on auth.devpanl.dev and not relevant here).
    const res = await fetch(`${apiUrl}/api/projects`);
    if (!res.ok) return 0;
    const { projects = [] } = await res.json();
    for (const p of projects) {
      if (!p.api_key) continue;
      addOrUpdateProject({
        id: p.id,
        name: p.name,
        api_key: p.api_key,
        github_repo: p.github_repo,
        plane_project_id: p.plane_project_id
      });
    }
    return projects.length;
  } catch {
    return 0;
  }
}

// Bulk-import all projects via admin key. Returns added count.
export async function importAllViaAdmin(apiUrl, adminKey) {
  const res = await fetch(`${apiUrl}/api/projects/summary`, {
    headers: { 'X-Admin-Key': adminKey }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `summary HTTP ${res.status}`);
  }
  const { projects = [] } = await res.json();
  for (const p of projects) {
    addOrUpdateProject({
      id: p.id, name: p.name, api_key: p.api_key,
      github_repo: p.github_repo, plane_project_id: p.plane_project_id
    });
  }
  setAdminKey(adminKey);
  return projects.length;
}
