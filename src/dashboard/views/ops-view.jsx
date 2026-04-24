// Ops view — surfaces Telegram plumbing health: outbound delivery status and
// untagged inbound drops. Requires admin key. Built on shadcn Card + Badge so
// we standardize the component language as we go.
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

const STATUS_VARIANT = {
  delivered: 'secondary',
  pending: 'outline',
  failed: 'destructive'
};

function useAdminKey() {
  return typeof localStorage !== 'undefined' ? localStorage.getItem('devpanel_admin_key') : null;
}

async function fetchJson(url, adminKey) {
  const r = await fetch(url, { headers: { 'X-Admin-Key': adminKey } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function RelativeTime({ iso }) {
  if (!iso) return null;
  const date = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  const delta = Date.now() - date.getTime();
  const min = Math.floor(delta / 60000);
  if (min < 1) return <span>just now</span>;
  if (min < 60) return <span>{min}m ago</span>;
  if (min < 1440) return <span>{Math.floor(min / 60)}h ago</span>;
  return <span>{Math.floor(min / 1440)}d ago</span>;
}

function OutboundTable({ rows }) {
  if (!rows?.length) {
    return <p className="text-sm text-muted-foreground px-6 pb-6">No outbound attempts yet.</p>;
  }
  return (
    <div className="divide-y">
      {rows.map(r => (
        <div key={r.id} className="px-6 py-3 flex items-start gap-3">
          <Badge variant={STATUS_VARIANT[r.status] || 'outline'}>{r.status}</Badge>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{r.transport}</span>
              {r.subject_type && <span>· {r.subject_type}/{r.subject_id}</span>}
              <span>· attempts {r.attempts}</span>
              <span>· <RelativeTime iso={r.created_at} /></span>
            </div>
            <div className="text-sm mt-1 truncate">{r.text}</div>
            {r.error && (
              <div className="text-xs text-destructive mt-1 font-mono">{r.error}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function DropsTable({ rows }) {
  if (!rows?.length) {
    return <p className="text-sm text-muted-foreground px-6 pb-6">No untagged messages dropped. Shelly is tagging everything.</p>;
  }
  return (
    <div className="divide-y">
      {rows.map(r => (
        <div key={r.id} className="px-6 py-3 flex items-start gap-3">
          <Badge variant="outline">{r.reason}</Badge>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {r.role && <span>role: {r.role}</span>}
              {r.telegram_message_id && <span>tg #{r.telegram_message_id}</span>}
              <span>· <RelativeTime iso={r.created_at} /></span>
            </div>
            <div className="text-sm mt-1 font-mono break-words">{r.raw_text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function OpsView({ apiUrl }) {
  const adminKey = useAdminKey();
  const [outbound, setOutbound] = useState(null);
  const [drops, setDrops] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  const refresh = useCallback(async () => {
    if (!adminKey) {
      setError('Admin key required — set it in Settings.');
      return;
    }
    try {
      const q = filter === 'all' ? '' : `?status=${filter}`;
      const [ob, dr] = await Promise.all([
        fetchJson(`${apiUrl}/api/admin/telegram-outbound${q}`, adminKey),
        fetchJson(`${apiUrl}/api/admin/telegram-drops`, adminKey)
      ]);
      setOutbound(ob.messages);
      setDrops(dr.drops);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [apiUrl, adminKey, filter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const failedCount = outbound?.filter(r => r.status === 'failed').length ?? 0;
  const pendingCount = outbound?.filter(r => r.status === 'pending').length ?? 0;

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                Telegram outbound
                {failedCount > 0 && <Badge variant="destructive">{failedCount} failed</Badge>}
                {pendingCount > 0 && <Badge variant="outline">{pendingCount} pending</Badge>}
              </CardTitle>
              <CardDescription>
                Messages the dashboard sent to Telegram. Failed ones used to be invisible — they show up here now.
              </CardDescription>
            </div>
            <div className="flex gap-1">
              {['all', 'failed', 'pending', 'delivered'].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                    filter === f ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <OutboundTable rows={outbound} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Untagged Telegram drops
            {drops?.length > 0 && <Badge variant="outline">{drops.length}</Badge>}
          </CardTitle>
          <CardDescription>
            Messages Shelly received without a <code className="font-mono">[thread:...]</code> prefix. Before today they disappeared silently.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DropsTable rows={drops} />
        </CardContent>
      </Card>
    </div>
  );
}
