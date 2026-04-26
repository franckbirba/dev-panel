// Work-items view, redesigned for a project manager — dense scannable table,
// Plane title + DEVPA-NN as the primary identity, status pill, current step,
// last activity. Click a row to open the side drawer with the full chain
// (workflow runs + jobs + artifacts).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

function useAdminKey() {
  return typeof localStorage !== 'undefined' ? localStorage.getItem('devpanel_admin_key') : null;
}

async function fetchJson(url, adminKey) {
  const r = await fetch(url, { headers: { 'X-Admin-Key': adminKey } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function shortId(id) {
  return id ? id.slice(0, 8) : '—';
}

function timeAgo(input) {
  if (!input) return '—';
  const ts = typeof input === 'number'
    ? input
    : Date.parse(String(input).replace(' ', 'T') + (String(input).endsWith('Z') ? '' : 'Z'));
  if (!Number.isFinite(ts)) return '—';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

// Roll-up status: the single thing a PM cares about in the list view.
function rollup(item) {
  if (item.active > 0) return { key: 'active', label: 'In progress', tone: 'info' };
  if (item.failed > 0 && item.done === 0) return { key: 'blocked', label: 'Blocked', tone: 'error' };
  if (item.failed > 0 && item.done > 0) return { key: 'mixed', label: 'Partial', tone: 'warning' };
  if (item.done > 0) return { key: 'shipped', label: 'Shipped', tone: 'success' };
  return { key: 'idle', label: 'Idle', tone: 'muted' };
}

const ROLLUP_TONE = {
  info:    { fg: 'var(--color-info)',    bg: 'var(--color-info-soft)',    bd: 'var(--color-info-border)'    },
  error:   { fg: 'var(--color-error)',   bg: 'var(--color-error-soft)',   bd: 'var(--color-error-border)'   },
  warning: { fg: 'var(--color-warning)', bg: 'var(--color-warning-soft)', bd: 'var(--color-warning-border)' },
  success: { fg: 'var(--color-success)', bg: 'var(--color-success-soft)', bd: 'var(--color-success-border)' },
  muted:   { fg: 'var(--color-foreground-muted)', bg: 'var(--color-surface-2)', bd: 'var(--color-border-subtle)' },
};

function StatusPill({ tone, label }) {
  const t = ROLLUP_TONE[tone] || ROLLUP_TONE.muted;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 h-[22px] rounded-full text-[11px] font-medium tabular-nums"
      style={{ color: t.fg, background: t.bg, border: `1px solid ${t.bd}` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.fg }} />
      {label}
    </span>
  );
}

const PRIORITY_TONE = {
  urgent: 'error',
  high:   'warning',
  medium: 'info',
  low:    'muted',
  none:   'muted',
};

function PriorityChip({ value }) {
  if (!value || value === 'none') return <span className="text-[12px] text-[var(--color-foreground-faint)]">—</span>;
  const tone = PRIORITY_TONE[value] || 'muted';
  const t = ROLLUP_TONE[tone];
  return (
    <span
      className="inline-flex items-center px-1.5 h-[18px] rounded text-[10.5px] font-semibold uppercase tracking-wide"
      style={{ color: t.fg, background: t.bg }}
    >
      {value === 'urgent' ? 'urg' : value.slice(0, 3)}
    </span>
  );
}

function PageHeader({ title, subtitle, right }) {
  return (
    <div className="flex items-center gap-3 px-6 h-14 border-b border-[var(--color-border-subtle)] shrink-0">
      <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
      {subtitle && <span className="text-[12px] text-[var(--color-foreground-faint)]">{subtitle}</span>}
      <div className="flex-1" />
      {right}
    </div>
  );
}

const FILTERS = [
  { key: 'all',      label: 'All' },
  { key: 'active',   label: 'In progress' },
  { key: 'blocked',  label: 'Blocked' },
  { key: 'mixed',    label: 'Partial' },
  { key: 'shipped',  label: 'Shipped' },
  { key: 'idle',     label: 'Idle' },
];

function FilterChips({ value, counts, onChange }) {
  return (
    <div className="flex items-center gap-1.5">
      {FILTERS.map(f => {
        const active = value === f.key;
        const count = counts[f.key] ?? 0;
        return (
          <button
            key={f.key}
            onClick={() => onChange(f.key)}
            className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[12px] font-medium transition-colors cursor-pointer"
            style={{
              background: active ? 'var(--color-surface-3)' : 'transparent',
              color: active ? 'var(--color-foreground)' : 'var(--color-foreground-muted)',
              border: `1px solid ${active ? 'var(--color-border-strong, #2f2f38)' : 'var(--color-border-subtle)'}`,
            }}
          >
            {f.label}
            <span className="text-[11px] tabular-nums opacity-60">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

function PrimaryCell({ item }) {
  const seq = item.sequence_id && item.identifier ? `${item.identifier}-${item.sequence_id}` : null;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {seq && (
          <span
            className="font-mono text-[10.5px] font-semibold px-1.5 h-[18px] rounded inline-flex items-center shrink-0"
            style={{ background: 'var(--color-surface-2)', color: 'var(--color-foreground-muted)', border: '1px solid var(--color-border-subtle)' }}
          >
            {seq}
          </span>
        )}
        <span className="text-[13.5px] font-medium text-[var(--color-foreground)] truncate" title={item.title || item.work_item_id}>
          {item.title || <span className="font-mono text-[var(--color-foreground-muted)]">{shortId(item.work_item_id)}</span>}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--color-foreground-faint)]">
        {item.project_name && <span>{item.project_name}</span>}
        {item.project_name && item.workflows && <span>·</span>}
        {item.workflows && (
          <span className="truncate">{item.workflows.split(',').join(' + ')}</span>
        )}
      </div>
    </div>
  );
}

function WorkItemRow({ item, selected, onOpen }) {
  const r = rollup(item);
  return (
    <div
      onClick={() => onOpen(item.work_item_id)}
      className="grid items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors"
      style={{
        gridTemplateColumns: 'minmax(0, 1fr) 110px 60px 110px 70px 130px',
        background: selected ? 'var(--color-surface-3)' : 'transparent',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--color-surface-2)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      <PrimaryCell item={item} />
      <StatusPill tone={r.tone} label={r.label} />
      <PriorityChip value={item.priority} />
      <span className="text-[12px] text-[var(--color-foreground-muted)] truncate" title={item.latest_step || ''}>
        {item.latest_step || '—'}
      </span>
      <span className="text-[12px] text-[var(--color-foreground-muted)] tabular-nums text-right">
        {item.instances}{item.failed > 0 && <span className="text-[var(--color-error)]"> · {item.failed} fail</span>}
      </span>
      <span className="text-[12px] text-[var(--color-foreground-faint)] tabular-nums text-right">
        {timeAgo(item.last_event_at)}
      </span>
    </div>
  );
}

function ColumnHeader() {
  return (
    <div
      className="grid items-center gap-3 px-4 py-2 text-[10.5px] uppercase tracking-wider font-semibold text-[var(--color-foreground-faint)]"
      style={{
        gridTemplateColumns: 'minmax(0, 1fr) 110px 60px 110px 70px 130px',
        borderBottom: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-1)',
      }}
    >
      <span>Work item</span>
      <span>Status</span>
      <span>Pri</span>
      <span>Current step</span>
      <span className="text-right">Runs</span>
      <span className="text-right">Last activity</span>
    </div>
  );
}

const INSTANCE_TONE = {
  done:              'success',
  running:           'info',
  awaiting_approval: 'warning',
  failed:            'error',
  blocked:           'error',
  exhausted:         'error',
};

function InstanceBadge({ status }) {
  const tone = INSTANCE_TONE[status] || 'muted';
  const t = ROLLUP_TONE[tone];
  return (
    <span
      className="inline-flex items-center px-1.5 h-[18px] rounded text-[10.5px] font-mono"
      style={{ color: t.fg, background: t.bg, border: `1px solid ${t.bd}` }}
    >
      {status}
    </span>
  );
}

function Chain({ detail }) {
  if (!detail) {
    return <div className="px-6 py-8 text-[13px] text-[var(--color-foreground-faint)]">Loading…</div>;
  }
  const { instances, jobs } = detail;

  return (
    <div className="space-y-6 px-6 py-5">
      <section>
        <h3 className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)] mb-2">Workflow runs</h3>
        <div className="surface" style={{ overflow: 'hidden' }}>
          {instances.length === 0 ? (
            <div className="px-4 py-6 text-[13px] text-center text-[var(--color-foreground-faint)]">No workflow instances.</div>
          ) : instances.map((inst, i) => (
            <div
              key={inst.id}
              className="flex items-center gap-3 px-4 py-2 text-[12.5px]"
              style={{ borderTop: i === 0 ? 'none' : '1px solid var(--color-border-subtle)' }}
            >
              <span className="font-mono text-[11px] text-[var(--color-foreground-faint)] w-12 shrink-0">#{inst.id}</span>
              <span className="font-mono text-[11.5px] text-[var(--color-foreground)] w-[100px] truncate">{inst.workflow_name}</span>
              <span className="text-[11px] text-[var(--color-foreground-muted)] w-[60px] truncate">rev {inst.revision}</span>
              <span className="text-[11.5px] text-[var(--color-foreground-muted)] flex-1 truncate">{inst.current_step}</span>
              <InstanceBadge status={inst.status} />
              <span className="text-[11px] text-[var(--color-foreground-faint)] w-[60px] text-right tabular-nums">{timeAgo(inst.last_event_at)}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)] mb-2">Jobs &amp; artifacts</h3>
        {jobs.length === 0 ? (
          <p className="text-[13px] text-[var(--color-foreground-faint)] px-2">No job log rows — events may have been purged or job hasn't finished.</p>
        ) : (
          <div className="space-y-2">
            {jobs.map(j => {
              const a = j.artifacts || {};
              const pr = a.pr_url;
              const branch = a.branch;
              const commits = Array.isArray(a.commits) ? a.commits : [];
              const files = Array.isArray(a.files_modified) ? a.files_modified : [];
              return (
                <div key={j.job_id} className="surface px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2 text-[12px] flex-wrap">
                    <span className="font-mono text-[11px] px-1.5 h-[18px] rounded inline-flex items-center" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border-subtle)' }}>
                      job {j.job_id}
                    </span>
                    {j.agent && <span className="capitalize text-[var(--color-foreground-muted)]">{j.agent}</span>}
                    {j.status && <InstanceBadge status={j.status} />}
                    {j.error_count > 0 && (
                      <span className="text-[11px] px-1.5 h-[18px] rounded inline-flex items-center" style={{ color: 'var(--color-error)', background: 'var(--color-error-soft)' }}>
                        {j.error_count} errors
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-[var(--color-foreground-faint)] tabular-nums">{timeAgo(j.last_at)}</span>
                  </div>
                  {(pr || branch || commits.length || files.length) ? (
                    <div className="text-[11.5px] space-y-1 pl-1">
                      {pr && (
                        <div>
                          <span className="text-[var(--color-foreground-faint)]">PR:</span>{' '}
                          <a href={pr} target="_blank" rel="noreferrer" className="text-[var(--color-info)] underline underline-offset-2 break-all">{pr}</a>
                        </div>
                      )}
                      {branch && !pr && (
                        <div>
                          <span className="text-[var(--color-foreground-faint)]">branch:</span>{' '}
                          <span className="font-mono text-[var(--color-foreground)]">{branch}</span>
                        </div>
                      )}
                      {commits.length > 0 && (
                        <div>
                          <span className="text-[var(--color-foreground-faint)]">commits:</span>{' '}
                          {commits.slice(0, 4).map((c, i) => (
                            <span key={i} className="font-mono text-[var(--color-foreground-muted)]">{i > 0 && ' · '}{typeof c === 'string' ? c.slice(0, 10) : JSON.stringify(c).slice(0, 20)}</span>
                          ))}
                          {commits.length > 4 && <span className="text-[var(--color-foreground-faint)]"> +{commits.length - 4}</span>}
                        </div>
                      )}
                      {files.length > 0 && (
                        <div>
                          <span className="text-[var(--color-foreground-faint)]">files:</span>{' '}
                          <span className="font-mono text-[var(--color-foreground-muted)]">{files.slice(0, 3).join(', ')}</span>
                          {files.length > 3 && <span className="text-[var(--color-foreground-faint)]"> +{files.length - 3}</span>}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11.5px] text-[var(--color-foreground-faint)] pl-1">No artifacts extracted.</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Drawer({ workItemId, detail, onClose }) {
  const seq = detail?.sequence_id && detail?.identifier ? `${detail.identifier}-${detail.sequence_id}` : null;

  // Close on Escape.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }}
      />
      <aside
        className="fixed top-0 right-0 bottom-0 z-50 flex flex-col"
        style={{
          width: 'min(640px, 100vw)',
          background: 'var(--color-surface-1)',
          borderLeft: '1px solid var(--color-border-subtle)',
          boxShadow: '-12px 0 40px rgba(0,0,0,0.4)',
        }}
      >
        <header
          className="flex items-start gap-3 px-6 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {seq && (
                <span
                  className="font-mono text-[11px] font-semibold px-1.5 h-[20px] rounded inline-flex items-center"
                  style={{ background: 'var(--color-surface-2)', color: 'var(--color-foreground-muted)', border: '1px solid var(--color-border-subtle)' }}
                >
                  {seq}
                </span>
              )}
              {detail?.priority && detail.priority !== 'none' && <PriorityChip value={detail.priority} />}
              {detail?.state_name && (
                <span className="text-[11px] text-[var(--color-foreground-muted)]">{detail.state_name}</span>
              )}
            </div>
            <h2 className="text-[15px] font-semibold tracking-tight mt-1.5 break-words">
              {detail?.title || <span className="font-mono">{workItemId}</span>}
            </h2>
            <div className="flex items-center gap-2 mt-1 text-[11.5px] text-[var(--color-foreground-faint)] flex-wrap">
              {detail?.project_name && <span>{detail.project_name}</span>}
              {detail?.project_name && <span>·</span>}
              <span className="font-mono">{shortId(workItemId)}</span>
              {detail?.plane_url && (
                <>
                  <span>·</span>
                  <a href={detail.plane_url} target="_blank" rel="noreferrer" className="text-[var(--color-info)] underline underline-offset-2">
                    Open in Plane ↗
                  </a>
                </>
              )}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <Chain detail={detail} />
        </div>
      </aside>
    </>
  );
}

export function WorkItemsView({ apiUrl }) {
  const adminKey = useAdminKey();
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [project, setProject] = useState('all');

  const loadItems = useCallback(async () => {
    if (!adminKey) {
      setError('Admin key required — set it in Settings.');
      return;
    }
    try {
      const r = await fetchJson(`${apiUrl}/api/admin/work-items`, adminKey);
      setItems(r.work_items);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, adminKey]);

  const loadDetail = useCallback(async (id) => {
    if (!adminKey || !id) return;
    setDetail(null);
    try {
      const r = await fetchJson(`${apiUrl}/api/admin/work-items/${encodeURIComponent(id)}`, adminKey);
      setDetail(r);
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, adminKey]);

  useEffect(() => {
    loadItems();
    const t = setInterval(loadItems, 15000);
    return () => clearInterval(t);
  }, [loadItems]);

  useEffect(() => {
    if (selected) loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  const projects = useMemo(() => {
    if (!items) return [];
    const set = new Set();
    items.forEach(i => i.project_name && set.add(i.project_name));
    return Array.from(set).sort();
  }, [items]);

  const counts = useMemo(() => {
    const c = { all: 0, active: 0, blocked: 0, mixed: 0, shipped: 0, idle: 0 };
    (items || []).forEach(i => {
      c.all++;
      c[rollup(i).key]++;
    });
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const ql = q.toLowerCase().trim();
    return items.filter(i => {
      if (filter !== 'all' && rollup(i).key !== filter) return false;
      if (project !== 'all' && i.project_name !== project) return false;
      if (!ql) return true;
      const seq = (i.sequence_id && i.identifier) ? `${i.identifier}-${i.sequence_id}`.toLowerCase() : '';
      return (
        i.work_item_id.toLowerCase().includes(ql) ||
        (i.title || '').toLowerCase().includes(ql) ||
        seq.includes(ql)
      );
    });
  }, [items, filter, project, q]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Work items"
        subtitle={`${counts.all} touched by agents · ${counts.active} in progress · ${counts.blocked} blocked`}
        right={
          <div className="flex items-center gap-2">
            <Input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search title or DEVPA-NN…"
              className="h-8 w-[260px]"
            />
            <Button variant="outline" size="sm" onClick={loadItems}>Refresh</Button>
          </div>
        }
      />

      {error && (
        <div
          className="mx-6 mt-4 px-4 py-3 rounded-lg text-[13px]"
          style={{ background: 'var(--color-error-soft)', border: '1px solid var(--color-error-border)', color: 'var(--color-error)' }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
        <FilterChips value={filter} counts={counts} onChange={setFilter} />
        {projects.length > 1 && (
          <>
            <span className="w-px h-5 bg-[var(--color-border-subtle)]" />
            <select
              value={project}
              onChange={e => setProject(e.target.value)}
              className="h-7 px-2 rounded-md text-[12px] bg-[var(--color-surface-1)] cursor-pointer"
              style={{ border: '1px solid var(--color-border-subtle)', color: 'var(--color-foreground)' }}
            >
              <option value="all">All projects</option>
              {projects.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <ColumnHeader />
        {!filtered && (
          <div className="px-6 py-12 text-[13px] text-[var(--color-foreground-faint)]">Loading…</div>
        )}
        {filtered && filtered.length === 0 && (
          <div className="px-6 py-12 text-[13px] text-[var(--color-foreground-faint)] text-center">
            No work items match this filter.
          </div>
        )}
        {filtered?.map(item => (
          <WorkItemRow
            key={item.work_item_id}
            item={item}
            selected={selected === item.work_item_id}
            onOpen={setSelected}
          />
        ))}
      </div>

      {selected && (
        <Drawer
          workItemId={selected}
          detail={detail}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
