// Live job log. Streams agent_job_events via SSE, renders a tail-follow feed.
// Events are Claude-Code stream-json lines captured by the worker and mirrored
// to services, so you get a real-time view of what the agent is doing without
// SSHing to hetzner.
import { useState, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';

const TYPE_VARIANT = {
  assistant:   'secondary',
  tool_use:    'default',
  tool_result: 'outline',
  result:      'secondary',
  error:       'destructive',
  system:      'outline',
};

function summarizeEvent(ev) {
  let payload = ev.payload_json;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return String(payload).slice(0, 200); }
  }
  // claude -p stream-json shapes
  const msg = payload?.message;
  if (ev.event_type === 'assistant' && msg?.content) {
    const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
    const text = parts.map(p => p?.type === 'text' ? p.text : p?.type === 'tool_use' ? `→ ${p.name}(…)` : '').filter(Boolean).join(' ');
    return text.slice(0, 400);
  }
  if (ev.event_type === 'tool_use') {
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    const use = parts.find(p => p?.type === 'tool_use');
    if (use) return `${use.name}(${JSON.stringify(use.input || {}).slice(0, 160)})`;
  }
  if (ev.event_type === 'tool_result') {
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    const res = parts.find(p => p?.type === 'tool_result');
    if (res) {
      const content = typeof res.content === 'string'
        ? res.content
        : Array.isArray(res.content) ? res.content.map(c => c.text || JSON.stringify(c)).join(' ') : JSON.stringify(res.content || '');
      return content.slice(0, 300);
    }
  }
  if (ev.event_type === 'result') {
    const d = payload?.duration_ms ? ` · ${Math.round(payload.duration_ms / 1000)}s` : '';
    const turns = payload?.num_turns != null ? ` · ${payload.num_turns} turns` : '';
    return `${payload?.subtype || 'done'}${d}${turns}`;
  }
  if (payload?.type === 'system') return payload?.subtype || 'system';
  return JSON.stringify(payload).slice(0, 200);
}

export function JobLog({ jobId, apiUrl, adminKey }) {
  const [events, setEvents] = useState([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState(null);
  const tailRef = useRef(null);
  const scrollRef = useRef(null);
  const [autoscroll, setAutoscroll] = useState(true);

  useEffect(() => {
    if (!jobId || !adminKey) return;
    setEvents([]);
    setLive(false);
    setError(null);
    // EventSource doesn't support custom headers, so admin key rides in the URL.
    // API accepts x-admin-key header OR ?admin_key query for exactly this reason.
    const url = `${apiUrl}/api/admin/jobs/${encodeURIComponent(jobId)}/events?stream=1&admin_key=${encodeURIComponent(adminKey)}`;
    const es = new EventSource(url);
    es.addEventListener('open', () => setLive(true));
    es.addEventListener('error', () => {
      setLive(false);
      setError('Stream disconnected');
    });
    es.addEventListener('job_event', (e) => {
      try {
        const ev = JSON.parse(e.data);
        setEvents(prev => [...prev, ev].slice(-500));
      } catch {}
    });
    es.addEventListener('job_done', () => {
      setLive(false);
      es.close();
    });
    return () => es.close();
  }, [jobId, apiUrl, adminKey]);

  useEffect(() => {
    if (autoscroll) tailRef.current?.scrollIntoView({ block: 'end' });
  }, [events, autoscroll]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoscroll(near);
  }

  if (!adminKey) {
    return <p className="text-xs text-muted-foreground">Admin key required to stream logs.</p>;
  }

  return (
    <div className="flex flex-col h-full min-h-[240px]">
      <div className="flex items-center gap-2 pb-2 shrink-0">
        <Badge variant={live ? 'secondary' : 'outline'} className={live ? 'text-emerald-400 border-emerald-400/40' : ''}>
          {live ? 'live' : events.length ? 'idle' : 'waiting'}
        </Badge>
        <span className="text-[11px] text-muted-foreground">{events.length} events</span>
        {error && <span className="text-[11px] text-destructive">· {error}</span>}
        <div className="flex-1" />
        <label className="text-[11px] text-muted-foreground flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={autoscroll} onChange={e => setAutoscroll(e.target.checked)} />
          follow
        </label>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto bg-background rounded-md border font-mono text-[11px]"
      >
        {events.length === 0 && (
          <div className="p-4 text-muted-foreground text-center">No events yet.</div>
        )}
        <div className="divide-y divide-border/50">
          {events.map((ev, i) => (
            <div key={`${ev.seq}-${i}`} className="px-3 py-1.5 flex items-start gap-2">
              <Badge variant={TYPE_VARIANT[ev.event_type] || 'outline'} className="text-[10px] h-4 px-1.5 shrink-0">
                {ev.event_type}
              </Badge>
              <span className="tabular-nums text-muted-foreground/60 shrink-0 w-10 text-right">#{ev.seq}</span>
              <span className="flex-1 whitespace-pre-wrap break-words text-foreground/80">
                {summarizeEvent(ev)}
              </span>
            </div>
          ))}
          <div ref={tailRef} />
        </div>
      </div>
    </div>
  );
}
