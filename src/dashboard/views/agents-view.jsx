// Agents roll-up. One card per agent — who's healthy, who's quiet, who's
// failing. Clicking a card opens the recent job log for that agent so you
// can see the last N steps without jumping into the queues view.
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

function useAdminKey() {
  return typeof localStorage !== 'undefined' ? localStorage.getItem('devpanel_admin_key') : null;
}

async function fetchJson(url, adminKey) {
  const r = await fetch(url, { headers: { 'X-Admin-Key': adminKey } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

// Wrap the shared helper so the rendered text matches this view's "Nm ago"
// suffix style. The shared helper handles BIGINT-as-string + ISO + numeric.
import { timeAgo as _timeAgoCore } from '@/lib/time';
function timeAgo(input) {
  const out = _timeAgoCore(input);
  if (out === '—' || out === 'now') return out === 'now' ? 'just now' : '—';
  return `${out} ago`;
}

// "Alive" = ran something in the last 24h. Colors health at a glance.
function healthOf(agent) {
  if (!agent.last_24h) return { label: 'idle', variant: 'outline', tone: 'text-muted-foreground' };
  if (agent.error > 0 && agent.error / Math.max(1, agent.total) > 0.1) {
    return { label: 'degraded', variant: 'destructive', tone: '' };
  }
  return { label: 'healthy', variant: 'secondary', tone: '' };
}

function successRate(agent) {
  if (!agent.total) return '—';
  return `${Math.round((agent.ok / agent.total) * 100)}%`;
}

function AgentCard({ agent, onOpen, active }) {
  const health = healthOf(agent);
  return (
    <Card
      className={`cursor-pointer transition-colors ${active ? 'border-primary' : 'hover:border-muted-foreground/40'}`}
      onClick={() => onOpen(agent.agent)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base capitalize">{agent.agent}</CardTitle>
            <CardDescription className="text-xs">{timeAgo(agent.last_seen)}</CardDescription>
          </div>
          <Badge variant={health.variant} className={health.tone}>{health.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">24h</div>
            <div className="text-sm font-semibold tabular-nums">{agent.last_24h}</div>
          </div>
          <div>
            <div className="text-muted-foreground">total</div>
            <div className="text-sm font-semibold tabular-nums">{agent.total}</div>
          </div>
          <div>
            <div className="text-muted-foreground">success</div>
            <div className="text-sm font-semibold tabular-nums">{successRate(agent)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">errors</div>
            <div className={`text-sm font-semibold tabular-nums ${agent.error > 0 ? 'text-destructive' : ''}`}>
              {agent.error}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const STEP_VARIANT = { ok: 'secondary', error: 'destructive', stub: 'outline' };

function RecentSteps({ steps }) {
  if (!steps?.length) {
    return <p className="text-sm text-muted-foreground px-6 pb-6">No recent steps for this agent.</p>;
  }
  return (
    <div className="divide-y max-h-[500px] overflow-y-auto">
      {steps.map(s => (
        <div key={s.id} className="px-6 py-2.5 flex items-center gap-3 text-sm">
          <Badge variant={STEP_VARIANT[s.status] || 'outline'} className="capitalize w-[68px] justify-center">
            {s.status}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground w-[90px] truncate" title={s.job_id}>
            {s.job_id}
          </span>
          <span className="flex-1 truncate">{s.step}</span>
          {s.duration_ms != null && (
            <span className="tabular-nums text-xs text-muted-foreground">
              {s.duration_ms}ms
            </span>
          )}
          <span className="text-xs text-muted-foreground w-[70px] text-right">{timeAgo(s.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}

export function AgentsView({ apiUrl }) {
  const adminKey = useAdminKey();
  const [agents, setAgents] = useState(null);
  const [selected, setSelected] = useState(null);
  const [steps, setSteps] = useState(null);
  const [error, setError] = useState(null);

  const loadAgents = useCallback(async () => {
    if (!adminKey) {
      setError('Admin key required — set it in Settings.');
      return;
    }
    try {
      const r = await fetchJson(`${apiUrl}/api/admin/agents`, adminKey);
      setAgents(r.agents);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, adminKey]);

  const loadSteps = useCallback(async (name) => {
    if (!adminKey || !name) return;
    try {
      const r = await fetchJson(`${apiUrl}/api/admin/agents/${encodeURIComponent(name)}/recent?limit=30`, adminKey);
      setSteps(r.steps);
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, adminKey]);

  useEffect(() => {
    loadAgents();
    const t = setInterval(loadAgents, 15000);
    return () => clearInterval(t);
  }, [loadAgents]);

  useEffect(() => {
    if (selected) loadSteps(selected);
  }, [selected, loadSteps]);

  const total24h = agents?.reduce((n, a) => n + a.last_24h, 0) ?? 0;
  const totalErrors = agents?.reduce((n, a) => n + a.error, 0) ?? 0;

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">
            {agents?.length ?? 0} agents · {total24h} jobs in last 24h · {totalErrors} lifetime errors
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAgents}>Refresh</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents?.map(a => (
          <AgentCard
            key={a.agent}
            agent={a}
            active={selected === a.agent}
            onOpen={setSelected}
          />
        ))}
      </div>

      {selected && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="capitalize">{selected} — recent steps</CardTitle>
                <CardDescription>Last 30 log rows, newest first.</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setSteps(null); }}>
                Close
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <RecentSteps steps={steps} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
