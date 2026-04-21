import { useState, useEffect, useCallback } from "react";
import {
  listLocalProjects, getCurrentProjectId, setCurrentProject,
  removeProject, importByApiKey, importAllViaAdmin,
  getAdminKey, setAdminKey, addOrUpdateProject
} from "@/lib/projects-store";
import { PasteUrlModal } from "@/components/paste-url-modal";

function StatusDot({ healthy }) {
  return <span className={`w-1.5 h-1.5 rounded-full ${healthy ? "bg-success" : "bg-muted-foreground/40"}`} />;
}

function timeAgo(iso) {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return iso;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}d`;
}

export function ProjectsView({ apiUrl, onProjectChange }) {
  const [localProjects, setLocalProjects] = useState(() => listLocalProjects());
  const [serverSummary, setServerSummary] = useState(null);
  const [adminKey, setAdminKeyState] = useState(getAdminKey);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);   // project being edited
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showPasteUrl, setShowPasteUrl] = useState(false);

  const refresh = useCallback(() => setLocalProjects(listLocalProjects()), []);

  // With admin key: one bulk /summary call returns every project enriched.
  // Without admin: fall back to per-project /whoami so the user still gets
  // real numbers for the projects they have api keys for.
  const loadSummary = useCallback(async () => {
    if (adminKey) {
      try {
        const r = await fetch(`${apiUrl}/api/projects/summary`, {
          headers: { 'X-Admin-Key': adminKey }
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { projects } = await r.json();
        setServerSummary(projects);
      } catch (e) {
        setStatus({ kind: 'error', text: `summary: ${e.message}` });
      }
      return;
    }
    // Fallback: parallel /whoami per project we have an api key for.
    const projects = listLocalProjects();
    const enriched = await Promise.all(projects.map(async p => {
      try {
        const r = await fetch(`${apiUrl}/api/whoami`, { headers: { 'X-API-Key': p.api_key } });
        if (r.ok) return await r.json();
      } catch { /* ignore — surface as missing row */ }
      return null;
    }));
    setServerSummary(enriched.filter(Boolean));
  }, [apiUrl, adminKey]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => {
    const id = setInterval(loadSummary, 15_000);
    return () => clearInterval(id);
  }, [loadSummary]);

  async function handleImportKey(e) {
    e.preventDefault();
    const key = e.target.elements.apikey.value.trim();
    if (!key) return;
    setBusy(true); setStatus(null);
    try {
      const p = await importByApiKey(apiUrl, key);
      refresh();
      setStatus({ kind: 'ok', text: `Added "${p.name}".` });
      e.target.reset();
      onProjectChange?.();
    } catch (e) { setStatus({ kind: 'error', text: e.message }); }
    finally { setBusy(false); }
  }

  async function handleImportAll(e) {
    e.preventDefault();
    const k = e.target.elements.adminkey.value.trim();
    if (!k) return;
    setBusy(true); setStatus(null);
    try {
      const n = await importAllViaAdmin(apiUrl, k);
      setAdminKeyState(k);
      refresh();
      setStatus({ kind: 'ok', text: `Imported ${n} project${n === 1 ? '' : 's'}.` });
      loadSummary();
      onProjectChange?.();
    } catch (e) { setStatus({ kind: 'error', text: e.message }); }
    finally { setBusy(false); }
  }

  async function handleCreate(form) {
    if (!adminKey) {
      setStatus({ kind: 'error', text: 'Admin key required to create projects.' });
      return;
    }
    setBusy(true); setStatus(null);
    try {
      const r = await fetch(`${apiUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify(form)
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      const project = await r.json();
      addOrUpdateProject(project);
      refresh();
      loadSummary();
      setCreating(false);
      onProjectChange?.();
      setStatus({ kind: 'ok', text: `Created "${project.name}".` });
    } catch (e) { setStatus({ kind: 'error', text: e.message }); }
    finally { setBusy(false); }
  }

  async function handlePatch(id, updates) {
    if (!adminKey) {
      setStatus({ kind: 'error', text: 'Admin key required to edit projects.' });
      return;
    }
    setBusy(true); setStatus(null);
    try {
      const r = await fetch(`${apiUrl}/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify(updates)
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      const updated = await r.json();
      addOrUpdateProject(updated);
      refresh();
      loadSummary();
      setEditing(null);
      onProjectChange?.();
      setStatus({ kind: 'ok', text: `Updated "${updated.name}".` });
    } catch (e) { setStatus({ kind: 'error', text: e.message }); }
    finally { setBusy(false); }
  }

  function handleDeleteLocal(id, name) {
    if (!confirm(`Remove "${name}" from this dashboard? (Project on server is not affected.)`)) return;
    removeProject(id);
    refresh();
    onProjectChange?.();
  }

  async function handleDeleteServer(id, name) {
    if (!adminKey) return;
    if (!confirm(`PERMANENTLY delete "${name}" on the server? This wipes its tickets and cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/projects/${id}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': adminKey }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      removeProject(id);
      refresh();
      loadSummary();
      onProjectChange?.();
      setStatus({ kind: 'ok', text: `Deleted "${name}" server-side.` });
    } catch (e) { setStatus({ kind: 'error', text: e.message }); }
    finally { setBusy(false); }
  }

  function rowFor(p) {
    const server = serverSummary?.find(s => s.id === p.id);
    const isCurrent = getCurrentProjectId() === p.id;
    return (
      <div key={p.id} className={`grid grid-cols-12 gap-3 items-center px-4 py-3 text-xs ${isCurrent ? "bg-secondary/40" : ""}`}>
        <div className="col-span-3 flex items-center gap-2 min-w-0">
          <StatusDot healthy={!!server} />
          <span className="font-mono truncate">{p.name}</span>
          {isCurrent && <span className="text-[10px] text-success uppercase tracking-wider">current</span>}
        </div>
        <div className="col-span-3 truncate text-muted-foreground font-mono">{p.github_repo || "—"}</div>
        <div className="col-span-2 truncate text-muted-foreground font-mono">
          {server?.plane_project_id ? server.plane_project_id.slice(0, 8) : (p.plane_project_id ? p.plane_project_id.slice(0,8) : "—")}
        </div>
        <div className="col-span-1 text-right tabular-nums text-muted-foreground">{server?.stats?.total ?? "—"}</div>
        <div className="col-span-1 text-right tabular-nums text-muted-foreground">{server?.active_workflows ?? "—"}</div>
        <div className="col-span-1 text-right text-muted-foreground">{timeAgo(server?.last_activity)}</div>
        <div className="col-span-1 flex justify-end gap-1.5">
          {!isCurrent && (
            <button onClick={() => { setCurrentProject(p.id); refresh(); onProjectChange?.(); }}
              className="px-2 py-0.5 text-[10px] rounded-md bg-secondary hover:bg-secondary/80 cursor-pointer">switch</button>
          )}
          <button onClick={() => setEditing(p)}
            className="px-2 py-0.5 text-[10px] rounded-md hover:bg-secondary cursor-pointer text-muted-foreground" title="Edit">edit</button>
          <button onClick={() => handleDeleteLocal(p.id, p.name)}
            className="px-2 py-0.5 text-[10px] rounded-md hover:bg-error/10 hover:text-error cursor-pointer text-muted-foreground" title="Remove from this dashboard only">×</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold tracking-tight">Projects</h2>
        <span className="text-xs text-muted-foreground">{localProjects.length} known locally{serverSummary && ` · ${serverSummary.length} on server`}</span>
        <div className="flex-1" />
        {adminKey && (
          <>
            <button onClick={() => setShowPasteUrl(true)}
              className="px-3 py-1 text-xs rounded-md border border-border hover:bg-secondary cursor-pointer">
              Paste GitHub URL
            </button>
            <button onClick={() => setCreating(true)}
              className="px-3 py-1 text-xs rounded-md bg-foreground text-background hover:bg-foreground/90 cursor-pointer">
              + New project
            </button>
          </>
        )}
      </div>

      {status && (
        <div className={`text-xs p-3 rounded-md font-mono ${status.kind === 'error' ? "bg-error/10 text-error" : "bg-success/10 text-success"}`}>
          {status.text}
        </div>
      )}

      {/* Empty state */}
      {localProjects.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground mb-4">No projects yet. Add one with an API key, or import all via your admin key.</p>
        </div>
      )}

      {/* Project table */}
      {localProjects.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="grid grid-cols-12 gap-3 px-4 py-2 bg-surface text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">
            <div className="col-span-3">Name</div>
            <div className="col-span-3">GitHub</div>
            <div className="col-span-2">Plane id</div>
            <div className="col-span-1 text-right">Tickets</div>
            <div className="col-span-1 text-right">In-flight</div>
            <div className="col-span-1 text-right">Last act.</div>
            <div className="col-span-1" />
          </div>
          <div className="divide-y divide-border">
            {localProjects.map(rowFor)}
          </div>
        </div>
      )}

      {/* Add by API key */}
      <details className="rounded-lg border border-border" open={localProjects.length === 0}>
        <summary className="px-4 py-2 text-xs cursor-pointer">Add by API key</summary>
        <form onSubmit={handleImportKey} className="px-4 pb-4 pt-1 flex gap-2">
          <input
            name="apikey" type="password" placeholder="dp_..." autoComplete="off"
            className="flex-1 h-8 px-3 rounded-md border border-border bg-background font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button disabled={busy} type="submit"
            className="h-8 px-3 rounded-md bg-foreground text-background text-xs disabled:opacity-50 cursor-pointer">
            {busy ? '…' : 'Add'}
          </button>
        </form>
      </details>

      {/* Import all via admin key */}
      <details className="rounded-lg border border-border">
        <summary className="px-4 py-2 text-xs cursor-pointer">Import all (admin key)</summary>
        <form onSubmit={handleImportAll} className="px-4 pb-4 pt-1 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Imports every project from the server in one go. The admin key is also kept locally so the dashboard can refresh metrics + create projects.
          </p>
          <div className="flex gap-2">
            <input
              name="adminkey" type="password" placeholder="admin key" autoComplete="off"
              defaultValue={adminKey}
              className="flex-1 h-8 px-3 rounded-md border border-border bg-background font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button disabled={busy} type="submit"
              className="h-8 px-3 rounded-md bg-foreground text-background text-xs disabled:opacity-50 cursor-pointer">
              {busy ? '…' : 'Import all'}
            </button>
            {adminKey && (
              <button type="button" onClick={() => { setAdminKey(''); setAdminKeyState(''); setServerSummary(null); }}
                className="h-8 px-3 rounded-md text-muted-foreground text-xs hover:bg-secondary cursor-pointer">
                Forget admin key
              </button>
            )}
          </div>
        </form>
      </details>

      {creating && (
        <ProjectFormModal
          title="New project"
          submitLabel="Create"
          initial={{}}
          onSubmit={handleCreate}
          onClose={() => setCreating(false)}
          busy={busy}
        />
      )}

      {showPasteUrl && (
        <PasteUrlModal
          apiUrl={apiUrl}
          onClose={() => setShowPasteUrl(false)}
          onCreated={() => { setShowPasteUrl(false); refresh(); loadSummary(); onProjectChange?.(); }}
        />
      )}

      {editing && (
        <ProjectFormModal
          title={`Edit ${editing.name}`}
          submitLabel="Save"
          initial={serverSummary?.find(s => s.id === editing.id) || editing}
          showDelete={!!adminKey}
          onDelete={() => handleDeleteServer(editing.id, editing.name)}
          onSubmit={(form) => handlePatch(editing.id, form)}
          onClose={() => setEditing(null)}
          busy={busy}
        />
      )}
    </div>
  );
}

function ProjectFormModal({ title, submitLabel, initial, onSubmit, onClose, busy, showDelete, onDelete }) {
  const [form, setForm] = useState({
    name: initial.name || '',
    description: initial.description || '',
    github_owner: initial.github_owner || '',
    github_repo: initial.github_repo || '',
    plane_project_id: initial.plane_project_id || '',
    plane_workspace_slug: initial.plane_workspace_slug || 'devpanl',
    default_branch: initial.default_branch || 'main',
    local_path: initial.local_path || ''
  });

  function update(k, v) { setForm(f => ({ ...f, [k]: v })); }
  function submit(e) {
    e.preventDefault();
    // Strip empties to avoid PATCH'ing with "" vs null mismatches.
    const out = {};
    for (const [k, v] of Object.entries(form)) {
      if (v !== '' && v !== null) out[k] = v;
    }
    onSubmit(out);
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6">
      <form onSubmit={submit} className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{title}</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">×</button>
        </div>
        <Field label="Name" required>
          <input value={form.name} onChange={e => update('name', e.target.value)}
            placeholder="my-project" className="input" required pattern="[a-zA-Z0-9._-]+" />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={e => update('description', e.target.value)} className="input" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="GitHub owner"><input value={form.github_owner} onChange={e => update('github_owner', e.target.value)} className="input" /></Field>
          <Field label="GitHub repo"><input value={form.github_repo} onChange={e => update('github_repo', e.target.value)} className="input" /></Field>
        </div>
        <Field label="Plane project id">
          <input value={form.plane_project_id} onChange={e => update('plane_project_id', e.target.value)}
            placeholder="uuid" className="input font-mono" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plane workspace"><input value={form.plane_workspace_slug} onChange={e => update('plane_workspace_slug', e.target.value)} className="input" /></Field>
          <Field label="Default branch"><input value={form.default_branch} onChange={e => update('default_branch', e.target.value)} className="input" /></Field>
        </div>
        <Field label="Local path on agents host">
          <input value={form.local_path} onChange={e => update('local_path', e.target.value)}
            placeholder="/home/deploy/projects/zeno" className="input font-mono" />
        </Field>
        <div className="flex items-center justify-end gap-2 pt-2">
          {showDelete && (
            <button type="button" onClick={onDelete} disabled={busy}
              className="mr-auto px-3 py-1.5 text-xs rounded-md text-error hover:bg-error/10 cursor-pointer">
              Delete on server
            </button>
          )}
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded-md hover:bg-secondary cursor-pointer">Cancel</button>
          <button type="submit" disabled={busy}
            className="px-3 py-1.5 text-xs rounded-md bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 cursor-pointer">
            {busy ? '…' : submitLabel}
          </button>
        </div>
        <style>{`
          .input { display:block; width:100%; height:32px; padding:0 12px;
            border:1px solid var(--color-border, #2a2a2a); border-radius:6px;
            background:var(--color-background, #0a0a0a); font-size:12px; outline:none;
          }
          .input:focus { border-color:var(--color-ring, #4b5563); box-shadow:0 0 0 1px var(--color-ring,#4b5563); }
        `}</style>
      </form>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {label}{required && " *"}
      </span>
      {children}
    </label>
  );
}
