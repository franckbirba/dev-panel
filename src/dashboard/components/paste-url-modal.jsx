// src/dashboard/components/paste-url-modal.jsx
import { useState, useRef, useEffect } from 'react';
import { getAdminKey, setAdminKey, addOrUpdateProject } from '@/lib/projects-store';

export function PasteUrlModal({ apiUrl, onClose, onCreated }) {
  const [url, setUrl] = useState('');
  const [adminKeyInput, setAdminKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(null); // null | 'probing' | 'done'
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const storedKey = getAdminKey();
  const needsKey = !storedKey;

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    const key = storedKey || adminKeyInput.trim();
    if (!key) { setError('Admin key required.'); return; }
    if (!url.trim()) return;

    setBusy(true); setError(null); setStep('probing');
    try {
      const r = await fetch(`${apiUrl}/api/projects/from-github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
        body: JSON.stringify({ github_url: url.trim() })
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);

      if (!storedKey && adminKeyInput.trim()) setAdminKey(adminKeyInput.trim());
      if (body.project) addOrUpdateProject(body.project);

      setStep('done');
      setResult(body);
      onCreated?.(body);
    } catch (e) {
      setError(e.message);
      setStep(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={e => e.stopPropagation()}
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Add project</h3>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">{'\u2715'}</button>
        </div>

        {step === 'done' && result ? (
          <div className="space-y-3">
            <div className="bg-success/10 text-success rounded-lg px-4 py-3 text-xs font-mono">
              {result.project?.name || 'Project'} created. Bootstrap job queued.
            </div>
            <button type="button" onClick={onClose}
              className="w-full h-9 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 cursor-pointer">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <label className="block text-[10px] uppercase tracking-wider text-muted-foreground">GitHub repo</label>
              <input
                ref={inputRef}
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring/60"
              />
            </div>

            {needsKey && (
              <div className="space-y-1.5">
                <label className="block text-[10px] uppercase tracking-wider text-muted-foreground">Admin key</label>
                <input
                  value={adminKeyInput}
                  onChange={e => setAdminKeyInput(e.target.value)}
                  type="password"
                  placeholder="admin key (remembered on this device)"
                  autoComplete="off"
                  className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring/60"
                />
              </div>
            )}

            {error && (
              <div className="text-xs text-error bg-error/10 rounded-lg px-3 py-2 font-mono">{error}</div>
            )}

            {step && (
              <div className="text-[11px] text-muted-foreground font-mono animate-pulse">
                Probing GitHub + creating Plane project...
              </div>
            )}

            <button type="submit" disabled={busy || !url.trim()}
              className="w-full h-9 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 disabled:opacity-50 cursor-pointer">
              {busy ? 'Working...' : 'Add and bootstrap'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
