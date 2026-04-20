import { useState } from "react";
import { addOrUpdateProject, setCurrentProject } from "@/lib/projects-store";

// One-click project bootstrap — paste a GitHub URL, choose Plane mode,
// server does the rest (creates devpanel project + api_key, optionally
// creates a Plane project via REST, returns suggested .devpanlrc.json).
export function NewProjectButton({ apiUrl, apiKey, onCreated }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    github_url: '', plane_mode: 'skip', plane_name: '',
    plane_project_id: '', name_override: '', description: ''
  });

  function reset() {
    setForm({ github_url: '', plane_mode: 'skip', plane_name: '', plane_project_id: '', name_override: '', description: '' });
    setResult(null); setError(null);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${apiUrl}/api/projects/wizard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(form)
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setResult(body);
      addOrUpdateProject(body.project);
      onCreated?.(body.project);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function switchTo() {
    if (!result?.project) return;
    setCurrentProject(result.project.id);
    setOpen(false);
    reset();
    onCreated?.(result.project);
    setTimeout(() => window.location.reload(), 100);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-2.5 py-1 text-xs rounded-md bg-foreground text-background hover:bg-foreground/90 cursor-pointer mr-2"
        title="Add a new project"
      >
        + new
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6" onClick={() => !busy && setOpen(false)}>
          <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-4" onClick={e => e.stopPropagation()}>
            {!result ? (
              <form onSubmit={submit} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">New project</h3>
                  <button type="button" onClick={() => { setOpen(false); reset(); }}
                    className="text-muted-foreground hover:text-foreground cursor-pointer">×</button>
                </div>

                <label className="block">
                  <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">GitHub URL *</span>
                  <input required value={form.github_url} onChange={e => setForm(f => ({ ...f, github_url: e.target.value }))}
                    placeholder="https://github.com/owner/repo"
                    className="block w-full h-9 px-3 rounded-md border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring/60" />
                  <span className="block text-[10px] text-muted-foreground/70 mt-1">
                    Project name auto-derived from the repo name (or override below).
                  </span>
                </label>

                <label className="block">
                  <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Name override</span>
                  <input value={form.name_override} onChange={e => setForm(f => ({ ...f, name_override: e.target.value }))}
                    placeholder="leave blank to use repo name"
                    className="block w-full h-9 px-3 rounded-md border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring/60" />
                </label>

                <label className="block">
                  <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Description</span>
                  <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    className="block w-full h-9 px-3 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring/60" />
                </label>

                <fieldset className="space-y-2">
                  <legend className="text-[10px] uppercase tracking-wider text-muted-foreground">Plane</legend>
                  {[
                    { value: 'skip',   label: 'Skip for now',       hint: "I'll wire Plane later" },
                    { value: 'link',   label: 'Link existing',      hint: 'paste a Plane project UUID below' },
                    { value: 'create', label: 'Create new',         hint: 'new Plane project auto-created with a derived identifier' }
                  ].map(opt => (
                    <label key={opt.value} className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-secondary/40">
                      <input type="radio" name="plane_mode" value={opt.value}
                        checked={form.plane_mode === opt.value}
                        onChange={e => setForm(f => ({ ...f, plane_mode: e.target.value }))}
                        className="mt-0.5 cursor-pointer" />
                      <div>
                        <div className="text-xs">{opt.label}</div>
                        <div className="text-[10px] text-muted-foreground">{opt.hint}</div>
                      </div>
                    </label>
                  ))}
                </fieldset>

                {form.plane_mode === 'link' && (
                  <label className="block">
                    <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Plane project UUID *</span>
                    <input required value={form.plane_project_id} onChange={e => setForm(f => ({ ...f, plane_project_id: e.target.value }))}
                      placeholder="d2522fed-e3f2-…"
                      className="block w-full h-9 px-3 rounded-md border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring/60" />
                  </label>
                )}
                {form.plane_mode === 'create' && (
                  <label className="block">
                    <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Plane project name</span>
                    <input value={form.plane_name} onChange={e => setForm(f => ({ ...f, plane_name: e.target.value }))}
                      placeholder="defaults to GitHub repo name"
                      className="block w-full h-9 px-3 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring/60" />
                  </label>
                )}

                {error && (
                  <div className="text-[11px] text-error bg-error/10 rounded-md p-2 font-mono">{error}</div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button type="button" onClick={() => { setOpen(false); reset(); }} disabled={busy}
                    className="px-3 py-1.5 text-xs rounded-md hover:bg-secondary cursor-pointer">Cancel</button>
                  <button type="submit" disabled={busy}
                    className="px-3 py-1.5 text-xs rounded-md bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 cursor-pointer">
                    {busy ? 'creating…' : 'Create project'}
                  </button>
                </div>
              </form>
            ) : (
              /* Success screen */
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-success">✓ Project "{result.project.name}" created</h3>
                  <button type="button" onClick={() => { setOpen(false); reset(); }}
                    className="text-muted-foreground hover:text-foreground cursor-pointer">×</button>
                </div>

                <div className="rounded-md bg-background border border-border p-3 space-y-2 text-xs">
                  <div><span className="text-muted-foreground">API key:</span> <code className="font-mono text-[10px] break-all">{result.project.api_key}</code></div>
                  {result.project.plane_project_id && (
                    <div><span className="text-muted-foreground">Plane:</span> <code className="font-mono text-[10px]">{result.project.plane_project_id}</code></div>
                  )}
                  <div><span className="text-muted-foreground">GitHub:</span> <code className="font-mono text-[10px]">{result.project.github_owner}/{result.project.github_repo}</code></div>
                </div>

                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Next step — in your project repo:</div>
                  <div className="rounded-md bg-background border border-border p-3 font-mono text-[11px] whitespace-pre-wrap">
{`# 1) Install the devpanl plugin in Claude Code (once)
/plugin marketplace add franckbirba/devpanl-claude-plugin
/plugin install devpanl@devpanl-claude-plugin

# 2) Wire this project
cd ${result.project.github_repo}
/devpanl:init
# then paste into .devpanlrc.json:
${JSON.stringify(result.next_steps.rc_snippet, null, 2)}`}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button type="button" onClick={() => { setOpen(false); reset(); }}
                    className="px-3 py-1.5 text-xs rounded-md hover:bg-secondary cursor-pointer">Stay here</button>
                  <button type="button" onClick={switchTo}
                    className="px-3 py-1.5 text-xs rounded-md bg-foreground text-background hover:bg-foreground/90 cursor-pointer">
                    Switch to {result.project.name}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
