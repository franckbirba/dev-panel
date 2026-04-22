import { useState, useEffect, useCallback } from "react";
import {
  listLocalProjects, getCurrentProjectId, setCurrentProject,
  removeProject, importByApiKey, importAllViaAdmin,
  getAdminKey, setAdminKey, addOrUpdateProject
} from "@/lib/projects-store";
import { PasteUrlModal } from "@/components/paste-url-modal";
import { IconPlus, IconClose } from "@/components/icons";

function StatusDot({ healthy }) {
  return <span className={`w-1.5 h-1.5 rounded-full ${healthy ? "bg-success" : "bg-muted-foreground/30"}`} />;
}

function ProjectAvatar({ name, isCurrent }) {
  const initials = (name || '?').slice(0, 2).toUpperCase();
  return (
    <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold font-mono shrink-0 ${
      isCurrent ? 'bg-brand/15 text-brand' : 'bg-white/[0.04] text-muted-foreground'
    }`}>{initials}</span>
  );
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
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showPasteUrl, setShowPasteUrl] = useState(false);

  const refresh = useCallback(() => setLocalProjects(listLocalProjects()), []);

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
    const projects = listLocalProjects();
    const enriched = await Promise.all(projects.map(async p => {
      try {
        const r = await fetch(`${apiUrl}/api/whoami`, { headers: { 'X-API-Key': p.api_key } });
        if (r.ok) return await r.json();
      } catch { /* ignore */ }
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

  function rowFor(p, i) {
    const server = serverSummary?.find(s => s.id === p.id);
    const isCurrent = getCurrentProjectId() === p.id;
    return (
      <div key={p.id} className={`grid grid-cols-12 gap-3 items-center px-4 py-3.5 text-xs animate-fade-in-up ${
        isCurrent ? "bg-brand/5" : "hover:bg-white/[0.02]"
      } transition-colors`}
        style={{ animationDelay: `${Math.min(i * 0.04, 0.3)}s` }}>
        <div className="col-span-3 flex items-center gap-2.5 min-w-0">
          <ProjectAvatar name={p.name} isCurrent={isCurrent} />
          <div className="min-w-0">
            <span className="font-mono truncate block">{p.name}</span>
            {isCurrent && <span className="text-[9px] text-brand uppercase tracking-wider">current</span>}
          </div>
        </div>
        <div className="col-span-3 truncate text-muted-foreground/50 font-mono">{p.github_repo || "—"}</div>
        <div className="col-span-2 truncate text-muted-foreground/50 font-mono">
          {server?.plane_project_id ? server.plane_project_id.slice(0, 8) : (p.plane_project_id ? p.plane_project_id.slice(0,8) : "—")}
        </div>
        <div className="col-span-1 text-right tabular-nums text-muted-foreground/50">{server?.stats?.total ?? "—"}</div>
        <div className="col-span-1 text-right tabular-nums text-muted-foreground/50">{server?.active_workflows ?? "—"}</div>
        <div className="col-span-1 text-right text-muted-foreground/50">{timeAgo(server?.last_activity)}</div>
        <div className="col-span-1 flex justify-end gap-1.5">
          {!isCurrent && (
            <button onClick={() => { setCurrentProject(p.id); refresh(); onProjectChange?.(); }}
              className="px-2 py-0.5 text-[10px] rounded-md bg-brand/10 text-brand hover:bg-brand/20 cursor-pointer transition-colors">switch</button>
          )}
          <button onClick={() => setEditing(p)}
            className="px-2 py-0.5 text-[10px] rounded-md hover:bg-white/5 cursor-pointer text-muted-foreground/50 hover:text-foreground transition-colors">edit</button>
          <button onClick={() => handleDeleteLocal(p.id, p.name)}
            className="px-2 py-0.5 text-[10px] rounded-md hover:bg-error/10 hover:text-error cursor-pointer text-muted-foreground/40 transition-colors">×</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Projects</h2>
        <span className="text-xs text-muted-foreground/40">{localProjects.length} known locally{serverSummary && ` · ${serverSummary.length} on server`}</span>
        <div className="flex-1" />
        {adminKey && (
          <>
            <button onClick={() => setShowPasteUrl(true)}
              className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-white/5 cursor-pointer transition-colors">
              Paste GitHub URL
            </button>
            <button onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-brand text-brand-foreground hover:bg-brand/90 cursor-pointer transition-all shadow-lg shadow-brand/10">
              <IconPlus width={14} height={14} />
              New project
            </button>
          </>
        )}
      </div>

      {status && (
        <div className={`text-xs p-3 rounded-lg font-mono ${status.kind === 'error' ? "bg-error/10 text-error border border-error/15" : "bg-success/10 text-success border border-success/15"}`}>
          {status.text}
        </div>
      )}

      {localProjects.length === 0 && (
        <div className="glass-card rounded-xl border-dashed p-12 text-center empty-state">
          <div className="w-14 h-14 rounded-2xl bg-brand/10 flex items-center justify-center mx-auto mb-4">
            <IconPlus width={24} height={24} className="text-brand" />
          </div>
          <p className="text-sm text-foreground/70 mb-1">No projects yet</p>
          <p className="text-xs text-muted-foreground/40">Add one with an API key, or import all via your admin key.</p>
        </div>
      )}

      {localProjects.length > 0 && (
        <div className="glass-card rounded-xl overflow-hidden">
          <div className="grid grid-cols-12 gap-3 px-4 py-2.5 border-b border-border text-[10px] uppercase tracking-widest text-muted-foreground/30 font-mono">
            <div className="col-span-3">Name</div>
            <div className="col-span-3">GitHub</div>
            <div className="col-span-2">Plane id</div>
            <div className="col-span-1 text-right">Tickets</div>
            <div className="col-span-1 text-right">In-flight</div>
            <div className="col-span-1 text-right">Last act.</div>
            <div className="col-span-1" />
          </div>
          <div className="divide-y divide-border/30">
            {localProjects.map((p, i) => rowFor(p, i))}
          </div>
        </div>
      )}

      {/* Add by API key */}
      <details className="glass-card rounded-xl" open={localProjects.length === 0}>
        <summary className="px-4 py-2.5 text-xs cursor-pointer text-foreground/70 hover:text-foreground transition-colors">Add by API key</summary>
        <form onSubmit={handleImportKey} className="px-4 pb-4 pt-1 flex gap-2">
          <input
            name="apikey" type="password" placeholder="dp_..." autoComplete="off"
            className="flex-1 h-9 px-3 rounded-lg border border-border bg-background/50 font-mono text-xs input-glow transition-all placeholder:text-muted-foreground/25"
          />
          <button disabled={busy} type="submit"
            className="h-9 px-4 rounded-lg bg-brand text-brand-foreground text-xs disabled:opacity-40 cursor-pointer hover:bg-brand/90 transition-all shadow-lg shadow-brand/10">
            {busy ? '…' : 'Add'}
          </button>
        </form>
      </details>

      {/* Import all via admin key */}
      <details className="glass-card rounded-xl">
        <summary className="px-4 py-2.5 text-xs cursor-pointer text-foreground/70 hover:text-foreground transition-colors">Import all (admin key)</summary>
        <form onSubmit={handleImportAll} className="px-4 pb-4 pt-1 space-y-2">
          <p className="text-[11px] text-muted-foreground/40">
            Imports every project from the server in one go. The admin key is also kept locally so the dashboard can refresh metrics + create projects.
          </p>
          <div className="flex gap-2">
            <input
              name="adminkey" type="password" placeholder="admin key" autoComplete="off"
              defaultValue={adminKey}
              className="flex-1 h-9 px-3 rounded-lg border border-border bg-background/50 font-mono text-xs input-glow transition-all placeholder:text-muted-foreground/25"
            />
            <button disabled={busy} type="submit"
              className="h-9 px-4 rounded-lg bg-brand text-brand-foreground text-xs disabled:opacity-40 cursor-pointer hover:bg-brand/90 transition-all shadow-lg shadow-brand/10">
              {busy ? '…' : 'Import all'}
            </button>
            {adminKey && (
              <button type="button" onClick={() => { setAdminKey(''); setAdminKeyState(''); setServerSummary(null); }}
                className="h-9 px-3 rounded-lg text-muted-foreground/50 text-xs hover:bg-white/5 cursor-pointer transition-colors">
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
    const out = {};
    for (const [k, v] of Object.entries(form)) {
      if (v !== '' && v !== null) out[k] = v;
    }
    onSubmit(out);
  }

  return (
    <div className="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-6">
      <form onSubmit={submit} className="modal-content rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-4 animate-scale-in">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{title}</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground/50 hover:text-foreground cursor-pointer p-1 rounded-md hover:bg-white/5 transition-colors">
            <IconClose width={16} height={16} />
          </button>
        </div>
        <Field label="Name" required>
          <input value={form.name} onChange={e => update('name', e.target.value)}
            placeholder="my-project" className="modal-input" required pattern="[a-zA-Z0-9._-]+" />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={e => update('description', e.target.value)} className="modal-input" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="GitHub owner"><input value={form.github_owner} onChange={e => update('github_owner', e.target.value)} className="modal-input" /></Field>
          <Field label="GitHub repo"><input value={form.github_repo} onChange={e => update('github_repo', e.target.value)} className="modal-input" /></Field>
        </div>
        <Field label="Plane project id">
          <input value={form.plane_project_id} onChange={e => update('plane_project_id', e.target.value)}
            placeholder="uuid" className="modal-input font-mono" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plane workspace"><input value={form.plane_workspace_slug} onChange={e => update('plane_workspace_slug', e.target.value)} className="modal-input" /></Field>
          <Field label="Default branch"><input value={form.default_branch} onChange={e => update('default_branch', e.target.value)} className="modal-input" /></Field>
        </div>
        <Field label="Local path on agents host">
          <input value={form.local_path} onChange={e => update('local_path', e.target.value)}
            placeholder="/home/deploy/projects/zeno" className="modal-input font-mono" />
        </Field>
        <div className="flex items-center justify-end gap-2 pt-2">
          {showDelete && (
            <button type="button" onClick={onDelete} disabled={busy}
              className="mr-auto px-3 py-1.5 text-xs rounded-lg text-error hover:bg-error/10 cursor-pointer transition-colors">
              Delete on server
            </button>
          )}
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg hover:bg-white/5 cursor-pointer text-muted-foreground transition-colors">Cancel</button>
          <button type="submit" disabled={busy}
            className="px-4 py-1.5 text-xs rounded-lg bg-brand text-brand-foreground hover:bg-brand/90 disabled:opacity-40 cursor-pointer transition-all shadow-lg shadow-brand/10">
            {busy ? '…' : submitLabel}
          </button>
        </div>
        <style>{`
          .modal-input { display:block; width:100%; height:36px; padding:0 12px;
            border:1px solid rgba(255,255,255,0.06); border-radius:10px;
            background:rgba(8,8,10,0.5); font-size:12px; outline:none;
            color: var(--color-foreground);
            transition: all 0.2s;
          }
          .modal-input:focus { border-color:rgba(99,102,241,0.4); box-shadow:0 0 0 3px rgba(99,102,241,0.1); }
          .modal-input::placeholder { color: rgba(144,144,168,0.25); }
        `}</style>
      </form>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-widest text-muted-foreground/40 mb-1 font-medium">
        {label}{required && " *"}
      </span>
      {children}
    </label>
  );
}
