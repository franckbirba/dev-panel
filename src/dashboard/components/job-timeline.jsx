import { useState, useEffect, useRef, useCallback } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';

const TYPE_STYLES = {
  system:      { bg: 'bg-muted/30',    border: 'border-muted/50',    badge: 'bg-muted text-muted-foreground',     label: 'system' },
  assistant:   { bg: 'bg-info/5',      border: 'border-info/20',     badge: 'bg-info/20 text-info',               label: 'assistant' },
  tool_use:    { bg: 'bg-warning/5',   border: 'border-warning/20',  badge: 'bg-warning/20 text-warning',         label: 'tool_use' },
  tool_result: { bg: 'bg-success/5',   border: 'border-success/20',  badge: 'bg-success/20 text-success',         label: 'tool_result' },
  result:      { bg: 'bg-success/10',  border: 'border-success/30',  badge: 'bg-success/20 text-success',         label: 'result' },
  unknown:     { bg: 'bg-muted/20',    border: 'border-muted/30',    badge: 'bg-muted text-muted-foreground',     label: 'unknown' },
};

function CollapsibleJson({ data, maxLen = 500 }) {
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const truncated = str.length > maxLen;
  const [expanded, setExpanded] = useState(false);

  return (
    <pre className="mt-1 p-2 bg-background/50 rounded text-[10px] font-mono text-foreground/70 whitespace-pre-wrap break-all max-h-60 overflow-auto">
      {expanded || !truncated ? str : str.slice(0, maxLen) + '\u2026'}
      {truncated && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-1 text-info hover:underline cursor-pointer text-[10px]"
        >
          {expanded ? 'collapse' : 'expand'}
        </button>
      )}
    </pre>
  );
}

function EventCard({ event }) {
  const [open, setOpen] = useState(false);
  let payload;
  try { payload = JSON.parse(event.payload_json); } catch { payload = null; }

  const style = TYPE_STYLES[event.event_type] || TYPE_STYLES.unknown;

  // Extract display content based on event type
  let content = null;
  if (payload) {
    if (event.event_type === 'assistant' && payload.message?.content) {
      const texts = payload.message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      if (texts) content = <p className="text-[11px] text-foreground/80 whitespace-pre-wrap break-words">{texts.slice(0, 2000)}</p>;
    } else if (event.event_type === 'tool_use') {
      content = (
        <div>
          <span className="text-[11px] font-semibold text-foreground/90">{payload.tool || payload.name || 'tool'}</span>
          {(payload.input || payload.tool_input) && (
            <CollapsibleJson data={payload.input || payload.tool_input} />
          )}
        </div>
      );
    } else if (event.event_type === 'tool_result') {
      const output = payload.output || payload.content || payload.result || '';
      content = (
        <div>
          <span className="text-[11px] font-semibold text-foreground/90">{payload.tool || payload.name || 'tool'}</span>
          {output && <CollapsibleJson data={output} />}
        </div>
      );
    } else if (event.event_type === 'result') {
      const resultText = payload.result || '';
      content = (
        <div>
          {payload.cost_usd != null && (
            <span className="text-[10px] text-muted-foreground mr-2">cost: ${payload.cost_usd?.toFixed(4)}</span>
          )}
          {payload.duration_ms != null && (
            <span className="text-[10px] text-muted-foreground mr-2">{(payload.duration_ms / 1000).toFixed(1)}s</span>
          )}
          {payload.num_turns != null && (
            <span className="text-[10px] text-muted-foreground">{payload.num_turns} turns</span>
          )}
          {typeof resultText === 'string' && resultText.length > 0 && (
            <CollapsibleJson data={resultText} maxLen={800} />
          )}
        </div>
      );
    } else if (event.event_type === 'system') {
      content = event.subtype ? (
        <span className="text-[10px] text-muted-foreground">{event.subtype}</span>
      ) : null;
    }
  }

  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} p-2.5 mb-1.5`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[9px] font-mono text-muted-foreground/60 w-6 text-right shrink-0">#{event.seq}</span>
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-medium ${style.badge}`}>
          {style.label}{event.subtype ? `:${event.subtype}` : ''}
        </span>
        <span className="text-[9px] text-muted-foreground/50 ml-auto">
          {event.created_at ? new Date(event.created_at).toLocaleTimeString() : ''}
        </span>
        {payload && !content && (
          <button onClick={() => setOpen(!open)} className="text-[9px] text-info hover:underline cursor-pointer">
            {open ? 'hide' : 'json'}
          </button>
        )}
      </div>
      {content}
      {open && payload && !content && <CollapsibleJson data={payload} />}
    </div>
  );
}

export function JobTimeline({ jobId, apiUrl, adminKey, onClose }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const stickRef = useRef(true);

  // Fetch events once
  const fetchEvents = useCallback(async () => {
    if (!jobId || !adminKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/admin/jobs/${jobId}/events`, {
        headers: { 'X-Admin-Key': adminKey }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [jobId, apiUrl, adminKey]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  // SSE live mode
  useEffect(() => {
    if (!live || !jobId || !adminKey) return;
    const lastSeq = events.length ? events[events.length - 1].seq : 0;
    const url = `${apiUrl}/api/admin/jobs/${jobId}/events?stream=1&after=${lastSeq}&key=${adminKey}`;
    const es = new EventSource(url);

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        setEvents(prev => {
          if (prev.some(p => p.seq === evt.seq)) return prev;
          return [...prev, evt];
        });
      } catch { /* skip malformed */ }
    };

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => es.close();
  }, [live, jobId, adminKey, apiUrl]);

  // Auto-scroll
  useEffect(() => {
    if (stickRef.current && scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [events]);

  const handleScroll = (e) => {
    const el = e.target;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  return (
    <div className="card-glow rounded-xl p-4 h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3 shrink-0">
        <h3 className="text-foreground text-sm font-mono font-semibold">Timeline</h3>
        <span className="text-[10px] font-mono text-muted-foreground">Job {jobId}</span>
        <div className="flex-1" />
        <button
          onClick={() => setLive(!live)}
          className={`px-2 py-0.5 rounded text-[10px] font-mono cursor-pointer ${
            live
              ? 'bg-success/20 text-success border border-success/30'
              : 'bg-muted/30 text-muted-foreground border border-muted/50'
          }`}
        >
          {live ? '\u25cf live' : '\u25cb static'}
        </button>
        <button
          onClick={fetchEvents}
          className="text-[10px] font-mono text-info hover:underline cursor-pointer"
        >
          refresh
        </button>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm cursor-pointer">\u00d7</button>
      </div>

      {error && (
        <div className="mb-2 px-3 py-1.5 rounded bg-error/10 border border-error/20 text-error text-[11px] font-mono">
          {error}
        </div>
      )}

      {/* Events */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto pr-1"
      >
        {loading && events.length === 0 && (
          <span className="text-muted-foreground/50 text-xs font-mono">Loading events\u2026</span>
        )}
        {!loading && events.length === 0 && (
          <span className="text-muted-foreground/50 text-xs font-mono">No events recorded</span>
        )}
        {events.map(evt => (
          <EventCard key={`${evt.job_id}-${evt.seq}`} event={evt} />
        ))}
      </div>

      {/* Footer */}
      <div className="mt-2 pt-2 border-t border-border/50 flex items-center gap-2 shrink-0">
        <span className="text-[10px] font-mono text-muted-foreground">
          {events.length} events
        </span>
      </div>
    </div>
  );
}
