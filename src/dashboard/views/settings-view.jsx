// src/dashboard/views/settings-view.jsx
// Single-column settings with horizontal section tabs. No inner sidebar.
import { useState, useEffect } from 'react';
import TeamPanel from './settings-team-panel.jsx';
import { getCurrentProject } from '@/lib/projects-store';

const SECTIONS = [
  { id: 'project',       label: 'Project'       },
  { id: 'access',        label: 'Access'        },
  { id: 'github',        label: 'GitHub'        },
  { id: 'team',          label: 'Team'          },
  { id: 'notifications', label: 'Notifications' },
  { id: 'storage',       label: 'Storage'       },
  { id: 'danger',        label: 'Danger Zone',  danger: true },
];

function AllowlistPanel({ apiUrl }) {
  const [emails, setEmails] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const [hint, setHint] = useState(null);

  const adminKey = () => localStorage.getItem('devpanel_admin_key') || '';

  async function load() {
    setError(null);
    const key = adminKey();
    if (!key) {
      setError('Set the admin key in the Project tab to manage the allowlist.');
      return;
    }
    try {
      const r = await fetch(`${apiUrl}/api/admin/allowlist`, {
        headers: { 'X-Admin-Key': key }
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      const body = await r.json();
      setEmails(body.emails || []);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); /* eslint-disable-line */ }, [apiUrl]);

  async function add(e) {
    e.preventDefault();
    const value = pendingEmail.trim().toLowerCase();
    if (!value) return;
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      const r = await fetch(`${apiUrl}/api/admin/allowlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey() },
        body: JSON.stringify({ email: value })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setEmails(body.emails || []);
      setPendingEmail('');
      setHint(body.alreadyPresent
        ? 'Already in the allowlist.'
        : 'Committed to main. Live in ~30s once CI refreshes oauth2-proxy.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(email) {
    if (!confirm(`Remove ${email} from the allowlist?`)) return;
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      const r = await fetch(`${apiUrl}/api/admin/allowlist/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': adminKey() }
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setEmails(body.emails || []);
      setHint(body.removed
        ? 'Committed. Live in ~30s.'
        : 'Email was not in the allowlist.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface px-5 py-4">
      <div className="text-[13px] text-[var(--color-foreground)] mb-1">Google SSO allowlist</div>
      <div className="text-[11.5px] text-[var(--color-foreground-faint)] mb-3">
        Each entry is one Google account allowed to sign in at devpanl.dev.
        Adding or removing commits <code className="font-mono">infra/config/oauth2-proxy-emails.txt</code>
        {' '}on main; CI refreshes oauth2-proxy and the change goes live in ~30s.
      </div>

      <form onSubmit={add} className="flex items-center gap-2 mb-4">
        <input
          type="email"
          required
          placeholder="alice@example.com"
          value={pendingEmail}
          onChange={e => setPendingEmail(e.target.value)}
          disabled={busy}
          className="input font-mono"
          style={{ width: 320 }}
        />
        <button
          type="submit"
          disabled={busy || !pendingEmail.trim()}
          className="h-7 px-3 rounded-md text-[12.5px] bg-[var(--color-brand)] text-black hover:opacity-90 disabled:opacity-40 cursor-pointer transition-opacity"
        >
          Invite
        </button>
      </form>

      {error && (
        <div className="text-[12px] text-[var(--color-error)] mb-3">{error}</div>
      )}
      {hint && !error && (
        <div className="text-[12px] text-[var(--color-foreground-muted)] mb-3">{hint}</div>
      )}

      {emails === null ? (
        <div className="text-[12px] text-[var(--color-foreground-faint)]">Loading…</div>
      ) : emails.length === 0 ? (
        <div className="text-[12px] text-[var(--color-foreground-faint)]">No emails yet.</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {emails.map(email => (
            <li
              key={email}
              className="flex items-center justify-between h-8 px-3 rounded-md bg-[var(--color-surface-1)] border border-[var(--color-border)]"
            >
              <span className="font-mono text-[12.5px] text-[var(--color-foreground)]">{email}</span>
              <button
                onClick={() => remove(email)}
                disabled={busy}
                className="text-[11.5px] text-[var(--color-foreground-faint)] hover:text-[var(--color-error)] cursor-pointer disabled:opacity-40 transition-colors"
                title="Remove from allowlist"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PageHeader({ children, right }) {
  return (
    <div className="flex items-center gap-3 px-6 h-14 border-b border-[var(--color-border-subtle)] shrink-0">
      <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-foreground)]">{children}</h1>
      <div className="flex-1" />
      {right}
    </div>
  );
}

function Tabs({ value, onChange, items }) {
  return (
    <div className="flex items-center gap-0 px-6 border-b border-[var(--color-border-subtle)] shrink-0">
      {items.map(it => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            onClick={() => onChange(it.id)}
            className={`relative h-10 px-3 text-[13px] cursor-pointer transition-colors ${
              active
                ? 'text-[var(--color-foreground)]'
                : it.danger
                  ? 'text-[var(--color-error)]/70 hover:text-[var(--color-error)]'
                  : 'text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            {it.label}
            {active && (
              <span className="absolute bottom-[-1px] left-2 right-2 h-[2px] rounded bg-[var(--color-brand)]" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-x-6 items-start py-4 border-b border-[var(--color-border-subtle)] last:border-0">
      <div className="pt-1.5">
        <div className="text-[13px] text-[var(--color-foreground)]">{label}</div>
        {hint && <div className="text-[11.5px] text-[var(--color-foreground-faint)] mt-0.5">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ReadOnlyValue({ value, mono = true }) {
  return (
    <div
      className={`px-3 h-7 inline-flex items-center rounded-md bg-[var(--color-surface-1)] border border-[var(--color-border)] text-[13px] text-[var(--color-foreground)] ${mono ? 'font-mono' : ''}`}
    >
      {value || <span className="text-[var(--color-foreground-faint)]">—</span>}
    </div>
  );
}

function DangerCard({ title, description, action }) {
  return (
    <div
      className="rounded-lg p-4 flex flex-col gap-3"
      style={{ background: 'var(--color-error-soft)', border: '1px solid var(--color-error-border)' }}
    >
      <div>
        <div className="text-[13px] font-semibold text-[var(--color-error)]">{title}</div>
        <div className="text-[11.5px] text-[var(--color-error)]/70 mt-1">{description}</div>
      </div>
      <code className="self-start text-[11.5px] font-mono px-2 py-1 rounded bg-black/30 text-[var(--color-error)]/90">
        {action}
      </code>
    </div>
  );
}

export function SettingsView({ apiUrl, apiKey }) {
  const [section, setSection] = useState('project');
  const [health, setHealth] = useState(null);
  const currentProject = getCurrentProject();

  useEffect(() => {
    fetch(`${apiUrl}/api/health`)
      .then(r => (r.ok ? r.json() : null))
      .then(setHealth)
      .catch(() => {});
  }, [apiUrl]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        right={
          <span className="flex items-center gap-2 text-[11.5px] font-mono text-[var(--color-foreground-faint)]">
            <span className={`w-1.5 h-1.5 rounded-full ${health?.status === 'ok' ? 'bg-[var(--color-success)] animate-glow-pulse' : 'bg-[var(--color-error)]'}`} />
            {health?.status === 'ok' ? 'Server healthy' : 'Checking…'}
            <span className="opacity-40">·</span>
            <span>v2.0.0</span>
          </span>
        }
      >
        Settings
      </PageHeader>
      <Tabs value={section} onChange={setSection} items={SECTIONS} />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[720px] px-6 py-6">
          {section === 'project' && (
            <>
              <p className="text-[12.5px] text-[var(--color-foreground-muted)] mb-4">
                Connection details for this DevPanel instance. Edit <code className="font-mono text-[var(--color-foreground)]">.devpanelrc.json</code> or use the CLI to change configuration.
              </p>
              <div className="surface px-5 py-1">
                <Field label="API URL" hint="Where this dashboard talks to the server.">
                  <ReadOnlyValue value={apiUrl} />
                </Field>
                <Field label="API key" hint="Used for project authentication.">
                  <ReadOnlyValue value={apiKey ? apiKey.slice(0, 12) + '…' : null} />
                </Field>
                <Field
                  label="Admin key"
                  hint="Optional. Enables queue admin actions (pause, retry, clean). Stored in this browser only."
                >
                  <input
                    type="password"
                    defaultValue={localStorage.getItem('devpanel_admin_key') || ''}
                    onChange={e => {
                      const v = e.target.value.trim();
                      if (v) localStorage.setItem('devpanel_admin_key', v);
                      else localStorage.removeItem('devpanel_admin_key');
                    }}
                    placeholder="Paste admin key…"
                    autoComplete="off"
                    className="input font-mono"
                    style={{ width: 320 }}
                  />
                </Field>
              </div>
            </>
          )}

          {section === 'access' && (
            <>
              <p className="text-[12.5px] text-[var(--color-foreground-muted)] mb-4">
                Manage who can sign in to devpanl.dev via Google.
              </p>
              <AllowlistPanel apiUrl={apiUrl} />
            </>
          )}

          {section === 'github' && (
            <>
              <p className="text-[12.5px] text-[var(--color-foreground-muted)] mb-4">
                GitHub integration for publishing tickets as issues and syncing comments.
              </p>
              <div className="surface px-5 py-1">
                <Field label="Repository" hint="Set in .devpanelrc.json under github.">
                  <ReadOnlyValue value="—" mono={false} />
                </Field>
                <Field label="Token" hint="Set via GITHUB_TOKEN environment variable.">
                  <ReadOnlyValue value="env: GITHUB_TOKEN" />
                </Field>
                <Field label="Sync mode" hint="Tickets publish as issues; closed issues sync status back.">
                  <span className="status-chip success"><span className="dot" />Bidirectional</span>
                </Field>
              </div>
            </>
          )}

          {section === 'team' && (
            <TeamPanel project={currentProject} apiKey={apiKey} apiUrl={apiUrl} />
          )}

          {section === 'notifications' && (
            <>
              <p className="text-[12.5px] text-[var(--color-foreground-muted)] mb-4">
                Alert channels and notification preferences.
              </p>
              <div className="surface px-5 py-1">
                <Field label="Telegram" hint="Routed via Shelly (the orchestration agent).">
                  <span className="status-chip"><span className="dot" />Configured</span>
                </Field>
                <Field label="Live events (SSE)" hint="Streams events to this dashboard.">
                  <span className="status-chip success"><span className="dot" />Active</span>
                </Field>
              </div>
            </>
          )}

          {section === 'storage' && (
            <>
              <p className="text-[12.5px] text-[var(--color-foreground-muted)] mb-4">
                Local SQLite storage configuration.
              </p>
              <div className="surface px-5 py-1">
                <Field label="Storage path"><ReadOnlyValue value="./storage" /></Field>
                <Field label="Max file size"><ReadOnlyValue value="10 MB" /></Field>
                <Field label="Screenshot format"><ReadOnlyValue value="BLOB (base64 → binary)" /></Field>
                <Field label="Database"><ReadOnlyValue value="SQLite via better-sqlite3" /></Field>
              </div>
            </>
          )}

          {section === 'danger' && (
            <>
              <p className="text-[12.5px] text-[var(--color-foreground-muted)] mb-4">
                Destructive actions. Run from the CLI to confirm intent.
              </p>
              <div className="flex flex-col gap-3">
                <DangerCard
                  title="Reset API key"
                  description="Generate a new API key. All connected clients will be disconnected."
                  action="dev-panel admin reset-key"
                />
                <DangerCard
                  title="Delete all tickets"
                  description="Permanently remove all tickets from this project. Cannot be undone."
                  action="dev-panel admin purge"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
