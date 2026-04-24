// Work-item chain view. Each card is one work_item_id: how many workflow
// instances touched it, what each run produced (branch, PR, commits), and
// the current state. Click one to expand the full chain.
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
  const ts = typeof input === 'number' ? input : Date.parse(input.replace(' ', 'T') + (input.endsWith('Z') ? '' : 'Z'));
  if (!Number.isFinite(ts)) return '—';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 1440)}d ago`;
}

const INSTANCE_VARIANT = {
  done:              { v: 'secondary', t: 'text-emerald-400 border-emerald-400/40' },
  running:           { v: 'default',   t: '' },
  awaiting_approval: { v: 'outline',   t: 'text-amber-400 border-amber-400/40' },
  failed:            { v: 'destructive', t: '' },
  blocked:           { v: 'destructive', t: '' },
  exhausted:         { v: 'destructive', t: '' },
};

function InstanceBadge({ status }) {
  const cfg = INSTANCE_VARIANT[status] || { v: 'outline', t: '' };
  return <Badge variant={cfg.v} className={cfg.t}>{status}</Badge>;
}

function WorkItemCard({ item, active, onOpen }) {
  const activeStatus = item.active > 0 ? 'active' : item.failed > 0 && item.done === 0 ? 'stuck' : item.done > 0 ? 'shipped' : 'idle';
  const tone = activeStatus === 'active' ? 'text-blue-400 border-blue-400/40'
             : activeStatus === 'stuck' ? 'text-destructive border-destructive/40'
             : activeStatus === 'shipped' ? 'text-emerald-400 border-emerald-400/40'
             : 'text-muted-foreground';
  return (
    <Card
      className={`cursor-pointer transition-colors ${active ? 'border-primary' : 'hover:border-muted-foreground/40'}`}
      onClick={() => onOpen(item.work_item_id)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-mono truncate" title={item.work_item_id}>
              {shortId(item.work_item_id)}
            </CardTitle>
            <CardDescription className="text-xs">
              {item.workflows?.split(',').join(' + ') || '—'} · {timeAgo(item.last_event_at)}
            </CardDescription>
          </div>
          <Badge variant="outline" className={tone}>{activeStatus}</Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div><div className="text-muted-foreground">runs</div><div className="text-sm font-semibold tabular-nums">{item.instances}</div></div>
          <div><div className="text-muted-foreground">done</div><div className="text-sm font-semibold tabular-nums text-emerald-400">{item.done}</div></div>
          <div><div className="text-muted-foreground">failed</div><div className={`text-sm font-semibold tabular-nums ${item.failed > 0 ? 'text-destructive' : ''}`}>{item.failed}</div></div>
          <div><div className="text-muted-foreground">active</div><div className={`text-sm font-semibold tabular-nums ${item.active > 0 ? 'text-blue-400' : ''}`}>{item.active}</div></div>
        </div>
      </CardContent>
    </Card>
  );
}

function Chain({ detail }) {
  if (!detail) return null;
  const { instances, jobs } = detail;
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-2">Workflow runs</h3>
        <div className="divide-y rounded-md border">
          {instances.map(inst => (
            <div key={inst.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
              <span className="font-mono text-xs text-muted-foreground w-14">#{inst.id}</span>
              <span className="font-mono text-xs w-[90px] truncate">{inst.workflow_name}</span>
              <span className="text-xs text-muted-foreground w-[80px] truncate">rev {inst.revision}</span>
              <span className="text-xs text-muted-foreground w-[90px] truncate">{inst.current_step}</span>
              <InstanceBadge status={inst.status} />
              <div className="flex-1" />
              {inst.last_job_id && (
                <span className="font-mono text-xs text-muted-foreground">job {inst.last_job_id}</span>
              )}
              <span className="text-xs text-muted-foreground w-[80px] text-right">{timeAgo(inst.last_event_at)}</span>
            </div>
          ))}
          {instances.length === 0 && (
            <div className="px-4 py-6 text-sm text-center text-muted-foreground">No workflow instances for this work item.</div>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2">Jobs + artifacts</h3>
        {jobs.length === 0 && (
          <p className="text-sm text-muted-foreground px-4 py-2">No job log rows — events may have been purged or job hasn't finished.</p>
        )}
        <div className="space-y-2">
          {jobs.map(j => {
            const a = j.artifacts || {};
            const pr = a.pr_url;
            const branch = a.branch;
            const commits = Array.isArray(a.commits) ? a.commits : [];
            const files = Array.isArray(a.files_modified) ? a.files_modified : [];
            return (
              <Card key={j.job_id}>
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-center gap-3 text-sm">
                    <Badge variant="outline" className="font-mono">job {j.job_id}</Badge>
                    {j.agent && <span className="capitalize">{j.agent}</span>}
                    {j.status && <InstanceBadge status={j.status} />}
                    {j.error_count > 0 && <Badge variant="destructive">{j.error_count} errors</Badge>}
                    <div className="flex-1" />
                    <span className="text-xs text-muted-foreground">{timeAgo(j.last_at)}</span>
                  </div>
                  {(pr || branch || commits.length || files.length) ? (
                    <div className="text-xs space-y-1 pl-1 pt-1">
                      {pr && (
                        <div>
                          <span className="text-muted-foreground">PR:</span>{' '}
                          <a href={pr} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{pr}</a>
                        </div>
                      )}
                      {branch && !pr && (
                        <div>
                          <span className="text-muted-foreground">branch:</span>{' '}
                          <span className="font-mono">{branch}</span>
                        </div>
                      )}
                      {commits.length > 0 && (
                        <div>
                          <span className="text-muted-foreground">commits:</span>{' '}
                          {commits.slice(0, 4).map((c, i) => (
                            <span key={i} className="font-mono">{i > 0 && ' · '}{typeof c === 'string' ? c.slice(0, 10) : JSON.stringify(c).slice(0, 20)}</span>
                          ))}
                          {commits.length > 4 && <span className="text-muted-foreground"> +{commits.length - 4}</span>}
                        </div>
                      )}
                      {files.length > 0 && (
                        <div>
                          <span className="text-muted-foreground">files:</span>{' '}
                          <span className="font-mono">{files.slice(0, 3).join(', ')}</span>
                          {files.length > 3 && <span className="text-muted-foreground"> +{files.length - 3}</span>}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground pl-1">No artifacts extracted (no final result event, or agent returned no branch/PR).</div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function WorkItemsView({ apiUrl }) {
  const adminKey = useAdminKey();
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');

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

  const filtered = items?.filter(i =>
    !q || i.work_item_id.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Work items</h1>
          <p className="text-sm text-muted-foreground">
            {items?.length ?? 0} work items have been touched by agents · every run, every PR, every artifact.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by id…" className="h-8 w-[200px]" />
          <Button variant="outline" size="sm" onClick={loadItems}>Refresh</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered?.map(item => (
          <WorkItemCard
            key={item.work_item_id}
            item={item}
            active={selected === item.work_item_id}
            onOpen={setSelected}
          />
        ))}
      </div>

      {selected && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <CardTitle className="font-mono truncate">{selected}</CardTitle>
                <CardDescription>Full chain: instances → jobs → artifacts.</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Close</Button>
            </div>
          </CardHeader>
          <CardContent className="p-6 pt-0">
            <Chain detail={detail} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
