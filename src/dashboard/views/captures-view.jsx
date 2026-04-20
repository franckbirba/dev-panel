import { useState, useEffect, useCallback, useRef } from "react";

const POLL_MS = 8_000;

const STATUS_STYLE = {
  new:      "bg-warning/15 text-warning",
  triaging: "bg-info/15 text-info",
  promoted: "bg-success/15 text-success",
  dropped:  "bg-muted-foreground/15 text-muted-foreground"
};

function timeAgo(iso) {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return iso;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}d`;
}

function StatusPill({ status }) {
  const cls = STATUS_STYLE[status] || STATUS_STYLE.new;
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider ${cls}`}>{status}</span>;
}

export function CapturesView({ apiUrl, apiKey }) {
  const [list, setList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [thread, setThread] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const captureInputRef = useRef(null);
  const replyInputRef = useRef(null);
  const threadEndRef = useRef(null);

  const loadList = useCallback(async () => {
    if (!apiKey) return;
    try {
      const r = await fetch(`${apiUrl}/api/captures`, { headers: { "X-API-Key": apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { captures } = await r.json();
      setList(captures);
      setError(null);
    } catch (e) { setError(e.message); }
  }, [apiUrl, apiKey]);

  const loadThread = useCallback(async (id) => {
    if (!id || !apiKey) return;
    try {
      const r = await fetch(`${apiUrl}/api/captures/${id}`, { headers: { "X-API-Key": apiKey } });
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
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [thread]);

  async function handleCapture(e) {
    e.preventDefault();
    const content = captureInputRef.current?.value.trim();
    if (!content) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiUrl}/api/captures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content, kind: 'idea' })
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
      await fetch(`${apiUrl}/api/captures/${selected}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ content, role: 'user' })
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
        body: JSON.stringify({ status })
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
        headers: { 'X-API-Key': apiKey }
      });
      if (selected === id) { setSelected(null); setThread(null); }
      await loadList();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const counts = list.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});

  return (
    <div className="h-full flex flex-col">
      {/* Capture bar — the whole point: zero-friction dump */}
      <form onSubmit={handleCapture} className="border-b border-border bg-surface px-4 py-3 flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">capture</span>
        <input
          ref={captureInputRef}
          placeholder="quoi qu'il te passe par la tête — bug, feature, idée, doute…"
          className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring/60"
          autoFocus
        />
        <button type="submit" disabled={busy}
          className="h-9 px-4 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50 cursor-pointer">
          drop it
        </button>
      </form>

      {error && <div className="px-4 py-2 text-[11px] text-error bg-error/5 border-b border-error/20 font-mono">{error}</div>}

      <div className="flex-1 flex overflow-hidden">
        {/* List panel */}
        <div className="w-1/3 min-w-[320px] border-r border-border overflow-y-auto">
          <div className="px-4 py-2 border-b border-border flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">
            <span>{list.length} capture{list.length === 1 ? '' : 's'}</span>
            {counts.new       && <span className="text-warning">· {counts.new} new</span>}
            {counts.triaging  && <span className="text-info">· {counts.triaging} triaging</span>}
            {counts.promoted  && <span className="text-success">· {counts.promoted} promoted</span>}
          </div>
          {list.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No captures yet. Dump something above and Shelly will pick it up.
            </div>
          )}
          {list.map(c => {
            const isSelected = selected === c.id;
            const lastLabel = c.last_role === 'shelly' ? 'shelly' : c.last_role === 'user' ? 'you' : c.last_role;
            return (
              <button
                key={c.id}
                onClick={() => setSelected(c.id)}
                className={`w-full text-left px-4 py-3 border-b border-border/50 hover:bg-secondary/30 transition-colors cursor-pointer ${isSelected ? "bg-secondary/50" : ""}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <StatusPill status={c.status} />
                  <span className="text-[10px] text-muted-foreground/60 font-mono ml-auto">{timeAgo(c.updated_at)}</span>
                </div>
                <div className="text-xs truncate">{c.content}</div>
                {c.message_count > 1 && (
                  <div className="text-[10px] text-muted-foreground mt-1 truncate">
                    <span className="text-muted-foreground/60">{lastLabel}:</span> {c.last_message}
                  </div>
                )}
                {c.plane_sequence_id && (
                  <div className="text-[10px] text-success mt-1 font-mono">→ DEVPA-{c.plane_sequence_id}</div>
                )}
              </button>
            );
          })}
        </div>

        {/* Thread panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!thread && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
              {list.length === 0 ? 'dump something and start the conversation' : 'pick a capture'}
            </div>
          )}

          {thread && (
            <>
              <div className="px-6 py-3 border-b border-border flex items-center gap-3">
                <StatusPill status={thread.status} />
                <span className="text-xs font-mono text-muted-foreground">
                  {thread.kind} · created {timeAgo(thread.created_at)}
                </span>
                {thread.plane_sequence_id && (
                  <span className="text-xs text-success font-mono">→ DEVPA-{thread.plane_sequence_id}</span>
                )}
                <div className="flex-1" />
                {thread.status !== 'promoted' && thread.status !== 'dropped' && (
                  <>
                    <button onClick={() => handleStatus(thread.id, 'dropped')} disabled={busy}
                      className="px-2 py-1 text-[11px] rounded hover:bg-secondary cursor-pointer text-muted-foreground">drop</button>
                  </>
                )}
                <button onClick={() => handleDelete(thread.id)} disabled={busy}
                  className="px-2 py-1 text-[11px] rounded hover:bg-error/10 hover:text-error cursor-pointer text-muted-foreground">delete</button>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
                {thread.messages.map(m => (
                  <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] rounded-lg px-3 py-2 text-xs ${
                      m.role === 'user'   ? 'bg-foreground text-background' :
                      m.role === 'shelly' ? 'bg-info/15 text-foreground border border-info/30' :
                                            'bg-secondary text-muted-foreground'
                    }`}>
                      {m.role !== 'user' && (
                        <div className="text-[10px] font-mono uppercase tracking-wider opacity-60 mb-1">{m.role}</div>
                      )}
                      <div className="whitespace-pre-wrap">{m.content}</div>
                      <div className="text-[10px] opacity-50 mt-1 font-mono">{timeAgo(m.created_at)}</div>
                    </div>
                  </div>
                ))}
                <div ref={threadEndRef} />
              </div>

              <form onSubmit={handleReply} className="border-t border-border px-6 py-3 flex items-center gap-2">
                <input
                  ref={replyInputRef}
                  placeholder="reply to shelly or add context…"
                  className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring/60"
                />
                <button type="submit" disabled={busy}
                  className="h-9 px-3 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50 cursor-pointer">
                  send
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
