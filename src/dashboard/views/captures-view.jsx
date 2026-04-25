// src/dashboard/views/captures-view.jsx
// Inbox: hero composer on top, list left, thread right. Zero-friction dump.
import { useState, useEffect, useCallback, useRef } from 'react';
import { IconSend } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { subscribeAdminEvents } from '@/lib/events';
import { getAdminKey } from '@/lib/projects-store';

const POLL_MS = 8_000;

// shadcn Badge variants. "outline" for new, "secondary" for triaging/promoted
// so the eye picks up the active items without shouting. Dropped = muted.
const STATUS_VARIANT = {
  new:      'outline',
  triaging: 'default',
  promoted: 'secondary',
  dropped:  'outline',
};
const STATUS_TONE = {
  new:      'text-amber-400 border-amber-400/40',
  triaging: '',
  promoted: 'text-emerald-400 border-emerald-400/40',
  dropped:  'text-muted-foreground/60 border-border',
};

// djb2 string hash → HSL hue. Same env string always gets the same pill color
// across dashboards, without hardcoding a palette. Saturation/lightness are
// fixed so pills look consistent against the surface palette.
function envHue(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h % 360;
}
function envPillStyle(env) {
  const hue = envHue(env);
  return {
    backgroundColor: `hsl(${hue}, 55%, 20%)`,
    color:           `hsl(${hue}, 75%, 82%)`,
    border:          `1px solid hsl(${hue}, 55%, 30%)`
  };
}

function StatusChip({ status }) {
  return (
    <Badge variant={STATUS_VARIANT[status] || 'outline'} className={STATUS_TONE[status] || ''}>
      {status}
    </Badge>
  );
}

function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return iso;
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtTs(ts) {
  if (typeof ts !== 'number') return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 23);
}

const CONSOLE_TONE = {
  log:   'text-[var(--color-foreground-muted)]',
  warn:  'text-[var(--color-warning)]',
  error: 'text-[var(--color-error)]',
};

function CaptureMetaPanel({ meta }) {
  const consoleEntries = Array.isArray(meta.console) ? meta.console : [];
  const networkErrors  = Array.isArray(meta.network) ? meta.network : [];
  const sessionReplay  = Array.isArray(meta.sessionReplay) ? meta.sessionReplay : [];
  const perf           = meta.performance && typeof meta.performance === 'object' ? meta.performance : null;
  const component      = meta.component;
  const dom            = typeof meta.dom === 'string' ? meta.dom : null;
  const appState       = meta.appState && typeof meta.appState === 'object' ? meta.appState : null;
  const componentProps = component?.props && typeof component.props === 'object' ? component.props : null;
  const hasComponentProps = componentProps && Object.keys(componentProps).length > 0;

  const hasContext = meta.url || meta.viewport || meta.userAgent || component;
  if (!hasContext && !consoleEntries.length && !networkErrors.length && !sessionReplay.length && !perf && !dom && !appState) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1 text-[11px]">
      {hasContext && (
        <details className="opacity-75" open>
          <summary className="cursor-pointer select-none">context</summary>
          <div className="mt-1 space-y-0.5 font-mono">
            {meta.url && <div>url: <a href={meta.url} target="_blank" rel="noreferrer" className="underline">{meta.url}</a></div>}
            {meta.viewport && <div>viewport: {meta.viewport.width}×{meta.viewport.height}</div>}
            {component?.name && <div>component: {component.name}{component.file ? ` (${component.file})` : ''}</div>}
            {hasComponentProps && (
              <pre className="whitespace-pre-wrap break-all opacity-80">props: {JSON.stringify(componentProps, null, 2)}</pre>
            )}
            {meta.userAgent && <div className="truncate" title={meta.userAgent}>ua: {meta.userAgent}</div>}
          </div>
        </details>
      )}

      {consoleEntries.length > 0 && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">console ({consoleEntries.length})</summary>
          <div className="mt-1 max-h-48 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] space-y-0.5">
            {consoleEntries.map((e, idx) => (
              <div key={idx} className={`flex gap-2 ${CONSOLE_TONE[e.level] || ''}`}>
                <span className="opacity-50 shrink-0">{fmtTs(e.timestamp)}</span>
                <span className="uppercase shrink-0 w-10">{e.level}</span>
                <span className="whitespace-pre-wrap break-all">{e.message}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {networkErrors.length > 0 && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">failed requests ({networkErrors.length})</summary>
          <div className="mt-1 max-h-48 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] space-y-0.5">
            {networkErrors.map((n, idx) => (
              <div key={idx} className="flex gap-2 text-[var(--color-error)]">
                <span className="opacity-50 shrink-0">{fmtTs(n.timestamp)}</span>
                <span className="shrink-0 w-12">{n.method}</span>
                <span className="shrink-0 w-12">{n.status}</span>
                <span className="break-all">{n.url}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {sessionReplay.length > 0 && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">session replay ({sessionReplay.length} events, last 30s)</summary>
          <div className="mt-1 max-h-48 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] space-y-0.5">
            {sessionReplay.map((ev, idx) => (
              <div key={idx} className="flex gap-2 text-[var(--color-foreground-muted)]">
                <span className="opacity-50 shrink-0 w-12 text-right">
                  {typeof ev.ts === 'number' ? `${(ev.ts / 1000).toFixed(2)}s` : ''}
                </span>
                <span className="shrink-0 w-16">{ev.type}</span>
                <span className="break-all">
                  {ev.type === 'click' && `${ev.target} @ ${ev.x},${ev.y}`}
                  {ev.type === 'scroll' && `${ev.target} → ${ev.scrollX},${ev.scrollY}`}
                  {ev.type === 'input' && ev.target}
                  {ev.type === 'navigation' && `${ev.from} → ${ev.to}`}
                  {ev.type === 'mutation' && `+${ev.added} -${ev.removed}`}
                  {ev.type === 'resize' && `${ev.width}×${ev.height}`}
                  {ev.type === 'error' && `${ev.message} (${ev.filename}:${ev.lineno})`}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {perf && (perf.lcp != null || perf.cls != null || perf.fcp != null) && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">performance</summary>
          <div className="mt-1 font-mono space-y-0.5">
            {perf.lcp != null && <div>LCP: {Math.round(perf.lcp)}ms</div>}
            {perf.fcp != null && <div>FCP: {Math.round(perf.fcp)}ms</div>}
            {perf.cls != null && <div>CLS: {perf.cls}</div>}
          </div>
        </details>
      )}

      {appState && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">
            app state{appState.truncated ? ' (truncated)' : ''}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] whitespace-pre-wrap break-all">
            {appState.json}
          </pre>
        </details>
      )}

      {dom && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">DOM snapshot ({Math.round(dom.length / 1024)} KB)</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] whitespace-pre-wrap break-all">
            {dom}
          </pre>
        </details>
      )}
    </div>
  );
}

export function CapturesView({ apiUrl, apiKey }) {
  const [list, setList]         = useState([]);
  const [allList, setAllList]   = useState([]);  // unfiltered — used for filter dropdown options
  const [selected, setSelected] = useState(null);
  const [thread, setThread]     = useState(null);
  const [error, setError]       = useState(null);
  const [busy, setBusy]         = useState(false);
  const [reporterFilter, setReporterFilter] = useState('');
  const [envFilter, setEnvFilter] = useState('');
  const captureInputRef = useRef(null);
  const replyInputRef   = useRef(null);
  const threadEndRef    = useRef(null);

  const loadList = useCallback(async () => {
    if (!apiKey) return;
    try {
      const full = await fetch(`${apiUrl}/api/captures`, { headers: { 'X-API-Key': apiKey } });
      if (!full.ok) throw new Error(`HTTP ${full.status}`);
      const fullBody = await full.json();
      setAllList(fullBody.captures);

      const qs = [];
      if (reporterFilter) qs.push(`reporter_id=${encodeURIComponent(reporterFilter)}`);
      if (envFilter)      qs.push(`environment=${encodeURIComponent(envFilter)}`);

      if (qs.length > 0) {
        const r = await fetch(`${apiUrl}/api/captures?${qs.join('&')}`, { headers: { 'X-API-Key': apiKey } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { captures } = await r.json();
        setList(captures);
      } else {
        setList(fullBody.captures);
      }
      setError(null);
    } catch (e) { setError(e.message); }
  }, [apiUrl, apiKey, reporterFilter, envFilter]);

  const loadThread = useCallback(async (id) => {
    if (!id || !apiKey) return;
    try {
      const r = await fetch(`${apiUrl}/api/captures/${id}`, { headers: { 'X-API-Key': apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setThread(await r.json());
    } catch (e) { setError(e.message); }
  }, [apiUrl, apiKey]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    const id = setInterval(() => {
      loadList();
      if (selected) loadThread(selected);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [loadList, loadThread, selected]);
  useEffect(() => { if (selected) loadThread(selected); }, [selected, loadThread]);
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [thread]);

  // Live thread updates via SSE — Shelly's Telegram replies and other tabs
  // both broadcast 'thread:message'. We dedup by message id and only update
  // the thread that's currently open, but always refresh the list so the
  // sidebar's last_message preview stays in sync.
  useEffect(() => {
    const adminKey = getAdminKey();
    if (!adminKey) return;
    const unsub = subscribeAdminEvents(adminKey, (type, data) => {
      if (type !== 'thread:message') return;
      if (data.subject_type === 'capture') {
        loadList();
        if (selected && data.subject_id === selected) {
          setThread(prev => {
            if (!prev) return prev;
            if (prev.messages?.some(m => m.id === data.message.id)) return prev;
            return { ...prev, messages: [...(prev.messages || []), data.message] };
          });
        }
      }
    });
    return unsub;
  }, [selected, loadList]);

  async function handleCapture(e) {
    e.preventDefault();
    const content = captureInputRef.current?.value.trim();
    if (!content) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content, kind: 'idea' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const newCap = await r.json();
      captureInputRef.current.value = '';
      await loadList();
      setSelected(newCap.id);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleReply(e) {
    e.preventDefault();
    const content = replyInputRef.current?.value.trim();
    if (!content || !selected) return;
    setBusy(true);
    try {
      await fetch(`${apiUrl}/api/threads/capture/${selected}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content, role: 'user' }),
      });
      replyInputRef.current.value = '';
      await loadThread(selected);
      loadList();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleStatus(id, status) {
    setBusy(true);
    try {
      await fetch(`${apiUrl}/api/captures/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ status }),
      });
      await loadList();
      if (selected === id) await loadThread(id);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this capture and its thread?')) return;
    setBusy(true);
    try {
      await fetch(`${apiUrl}/api/captures/${id}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': apiKey },
      });
      if (selected === id) { setSelected(null); setThread(null); }
      await loadList();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const counts = list.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});

  const reporters = Array.from(
    allList.reduce((m, c) => {
      if (c.reporter_id) m.set(c.reporter_id, c.reporter_name || c.reporter_email || c.reporter_id);
      return m;
    }, new Map())
  );

  const environments = Array.from(new Set(
    allList.map(c => c.environment).filter(Boolean)
  )).sort();

  return (
    <div className="h-full flex flex-col">
      {/* Header + hero composer */}
      <div className="px-6 pt-5 pb-4 border-b border-[var(--color-border-subtle)] shrink-0">
        <div className="flex items-baseline gap-3 mb-3">
          <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-foreground)]">Inbox</h1>
          <span className="text-[11.5px] text-[var(--color-foreground-faint)]">
            Capture anything — bug, feature, idea, doubt. Shelly will triage.
          </span>
        </div>
        <form onSubmit={handleCapture} className="flex items-stretch gap-2">
          <Input
            ref={captureInputRef}
            placeholder="Quoi qu'il te passe par la tête…"
            className="flex-1 h-10 text-sm"
            autoFocus
          />
          <Button type="submit" disabled={busy} size="lg">
            <IconSend width={14} height={14} />
            <span>Drop it</span>
          </Button>
        </form>
      </div>

      {error && (
        <div className="px-4 py-2 text-[11px] text-[var(--color-error)] font-mono border-b border-[var(--color-error-border)]" style={{ background: 'var(--color-error-soft)' }}>
          {error}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* List */}
        <div className="w-[340px] shrink-0 border-r border-[var(--color-border-subtle)] overflow-y-auto flex flex-col">
          <div className="px-4 h-9 flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)] border-b border-[var(--color-border-subtle)] shrink-0">
            <span>{list.length} capture{list.length === 1 ? '' : 's'}</span>
            {counts.new      ? <span className="text-[var(--color-warning)] normal-case font-normal tracking-normal">· {counts.new} new</span>      : null}
            {counts.triaging ? <span className="text-[var(--color-info)] normal-case font-normal tracking-normal">· {counts.triaging} triaging</span> : null}
            {counts.promoted ? <span className="text-[var(--color-success)] normal-case font-normal tracking-normal">· {counts.promoted} promoted</span> : null}
            {reporters.length > 0 && (
              <select
                value={reporterFilter}
                onChange={(e) => setReporterFilter(e.target.value)}
                className="ml-auto text-[11px] bg-transparent border border-[var(--color-border-subtle)] rounded px-1 py-0.5 normal-case font-normal tracking-normal"
              >
                <option value="">all reporters</option>
                {reporters.map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            )}
            {environments.length > 0 && (
              <select
                value={envFilter}
                onChange={(e) => setEnvFilter(e.target.value)}
                className="text-[11px] bg-transparent border border-[var(--color-border-subtle)] rounded px-1 py-0.5 normal-case font-normal tracking-normal"
              >
                <option value="">all envs</option>
                {environments.map((env) => (
                  <option key={env} value={env}>{env}</option>
                ))}
              </select>
            )}
          </div>
          {list.length === 0 && (
            <div className="p-6 text-center text-[12px] text-[var(--color-foreground-faint)]">
              No captures yet. Dump something above and Shelly will pick it up.
            </div>
          )}
          {list.map((c, i) => {
            const isSelected = selected === c.id;
            const lastLabel = c.last_role === 'shelly' ? 'shelly' : c.last_role === 'user' ? 'you' : c.last_role;
            return (
              <button
                key={c.id}
                onClick={() => setSelected(c.id)}
                className={`text-left px-4 py-3 border-b border-[var(--color-border-subtle)] cursor-pointer transition-colors animate-fade-in-up ${
                  isSelected ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-2)]'
                }`}
                style={{ animationDelay: `${Math.min(i * 0.02, 0.2)}s` }}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <StatusChip status={c.status} />
                  {(c.reporter_name || c.reporter_email) && (
                    <span className="text-[10.5px] text-[var(--color-foreground-muted)] truncate max-w-[120px]">
                      {c.reporter_name || c.reporter_email}
                    </span>
                  )}
                  {c.environment && (
                    <span
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wide"
                      style={envPillStyle(c.environment)}
                    >
                      {c.environment}
                    </span>
                  )}
                  <span className="text-[10.5px] text-[var(--color-foreground-faint)] font-mono ml-auto">{timeAgo(c.updated_at)}</span>
                </div>
                <div className="text-[13px] text-[var(--color-foreground)] truncate">{c.content}</div>
                {c.message_count > 1 && c.last_role !== 'system' && (
                  <div className="text-[11.5px] text-[var(--color-foreground-faint)] mt-1 truncate">
                    <span className="opacity-70">{lastLabel}:</span> {c.last_message}
                  </div>
                )}
                {c.plane_sequence_id && (
                  <div className="text-[10.5px] text-[var(--color-success)] mt-1 font-mono">→ DEVPA-{c.plane_sequence_id}</div>
                )}
              </button>
            );
          })}
        </div>

        {/* Thread */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!thread && (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--color-foreground-faint)]">
              {list.length === 0 ? 'Dump something and start the conversation' : 'Pick a capture'}
            </div>
          )}

          {thread && (
            <>
              <div className="h-11 px-5 flex items-center gap-3 border-b border-[var(--color-border-subtle)] shrink-0">
                <StatusChip status={thread.status} />
                <span className="text-[11.5px] font-mono text-[var(--color-foreground-faint)]">
                  {thread.kind} · {timeAgo(thread.created_at)}
                </span>
                {(thread.reporter_name || thread.reporter_email) && (
                  <span className="text-[11.5px] text-[var(--color-foreground-muted)]">
                    by {thread.reporter_name || thread.reporter_email}
                    {thread.reporter_email && thread.reporter_name ? ` (${thread.reporter_email})` : ''}
                  </span>
                )}
                {thread.plane_sequence_id && (
                  <span className="text-[11.5px] text-[var(--color-success)] font-mono">→ DEVPA-{thread.plane_sequence_id}</span>
                )}
                <div className="flex-1" />
                {thread.status !== 'promoted' && thread.status !== 'dropped' && (
                  <Button variant="ghost" size="sm" onClick={() => handleStatus(thread.id, 'dropped')} disabled={busy}>Drop</Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => handleDelete(thread.id)} disabled={busy} className="text-destructive hover:text-destructive">Delete</Button>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {thread.messages.map((m, i) => {
                  const mine = m.role === 'user';
                  let meta = null;
                  if (m.metadata) {
                    try { meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata; }
                    catch { meta = null; }
                  }
                  const screenshot = meta?.screenshot && typeof meta.screenshot === 'string' && meta.screenshot.startsWith('data:image') ? meta.screenshot : null;
                  return (
                    <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'} animate-fade-in-up`}
                         style={{ animationDelay: `${Math.min(i * 0.02, 0.2)}s` }}>
                      <div
                        className={`max-w-[70%] rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
                          mine
                            ? 'text-[var(--color-foreground)]'
                            : m.role === 'shelly'
                              ? 'text-[var(--color-foreground)]'
                              : 'text-[var(--color-foreground-muted)]'
                        }`}
                        style={{
                          background: mine ? 'var(--color-brand-soft)' : m.role === 'shelly' ? 'var(--color-info-soft)' : 'var(--color-surface-2)',
                          border: `1px solid ${mine ? 'var(--color-brand-border)' : m.role === 'shelly' ? 'var(--color-info-border)' : 'var(--color-border)'}`,
                        }}
                      >
                        {!mine && (
                          <div className="text-[10px] font-mono uppercase tracking-wider opacity-60 mb-1">{m.role}</div>
                        )}
                        <div className="whitespace-pre-wrap">{m.content}</div>
                        {screenshot && (
                          <a href={screenshot} target="_blank" rel="noreferrer" className="block mt-2">
                            <img
                              src={screenshot}
                              alt="screenshot"
                              className="rounded border border-[var(--color-border)] max-h-64 w-auto hover:opacity-90 transition-opacity"
                            />
                          </a>
                        )}
                        {meta && <CaptureMetaPanel meta={meta} />}
                        <div className="text-[10px] opacity-50 mt-1.5 font-mono flex items-center gap-2">
                          <span>{timeAgo(m.created_at)}</span>
                          {mine && m.delivery && (
                            <span
                              title={m.delivery.error || m.delivery.transport || ''}
                              className={
                                m.delivery.status === 'delivered' ? 'text-[var(--color-success)]'
                                : m.delivery.status === 'failed' ? 'text-[var(--color-error)]'
                                : 'text-[var(--color-warning)]'
                              }
                            >
                              · {m.delivery.status === 'delivered' ? '✓ telegram' : m.delivery.status}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={threadEndRef} />
              </div>

              <form onSubmit={handleReply} className="border-t border-[var(--color-border-subtle)] px-5 py-3 flex items-center gap-2 shrink-0">
                <Input
                  ref={replyInputRef}
                  placeholder="Reply to Shelly or add context…"
                  className="flex-1 h-9"
                />
                <Button type="submit" size="icon" disabled={busy}>
                  <IconSend width={14} height={14} />
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
