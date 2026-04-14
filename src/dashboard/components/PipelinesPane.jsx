// src/dashboard/components/PipelinesPane.jsx
import { useEffect, useState } from 'react';
import { subscribeWorkflowEvents } from '../lib/workflow-events.js';

const STATUS_COLOR = {
  running: 'text-blue-500',
  awaiting_approval: 'text-amber-500',
  done: 'text-emerald-500',
  blocked: 'text-rose-500',
  failed: 'text-rose-600',
  exhausted: 'text-rose-700'
};

export function PipelinesPane({ adminKey }) {
  const [instances, setInstances] = useState([]);
  const [fadingIds, setFadingIds] = useState(new Set());

  async function refresh() {
    if (!adminKey) return;
    try {
      const r = await fetch('/api/admin/workflows/instances', {
        headers: { 'X-Admin-Key': adminKey }
      });
      const j = await r.json();
      setInstances(j.instances || []);
    } catch (err) {
      console.warn('[PipelinesPane] refresh failed', err);
    }
  }

  useEffect(() => {
    if (!adminKey) return;
    refresh();
    const unsub = subscribeWorkflowEvents(adminKey, {
      'workflow.started':      () => refresh(),
      'workflow.transitioned': () => refresh(),
      'workflow.finished':     (p) => {
        // server's listActive() already drops terminal rows; the fade is just a
        // brief visual cue that shows before refresh() clears the row
        setFadingIds(s => new Set(s).add(p.instance_id));
        refresh();
      }
    });
    return unsub;
  }, [adminKey]);

  // Keep fadingIds bounded: prune ids that no longer appear in instances
  useEffect(() => {
    const liveIds = new Set(instances.map(r => r.id));
    setFadingIds(s => {
      const next = new Set([...s].filter(id => liveIds.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [instances]);

  if (!adminKey) return <div className="text-sm text-gray-400">Paste admin key to view pipelines.</div>;
  if (!instances.length) return <div className="text-sm text-gray-400">No active pipelines.</div>;

  const byCycle = new Map();
  for (const r of instances) {
    const k = r.cycle_id || '(no cycle)';
    if (!byCycle.has(k)) byCycle.set(k, []);
    byCycle.get(k).push(r);
  }

  return (
    <div className="space-y-4" aria-live="polite">
      {[...byCycle.entries()].map(([cycle, rows]) => (
        <section key={cycle}>
          <h4 className="text-sm font-semibold text-gray-600 mb-1">Cycle: {cycle}</h4>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th>Work item</th><th>Workflow</th><th>Rev</th><th>Step</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}
                    className={fadingIds.has(r.id) ? 'opacity-40 transition-opacity' : ''}>
                  <td className="font-mono">{r.work_item_id}</td>
                  <td>{r.workflow_name}</td>
                  <td>{r.revision}</td>
                  <td>{r.current_step}</td>
                  <td className={STATUS_COLOR[r.status] || ''}>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
