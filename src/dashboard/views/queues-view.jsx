// src/dashboard/views/queues-view.jsx
import { useState, useEffect } from 'react';
import { QueueCard } from '@/components/queue-card';
import { JobList } from '@/components/job-list';
import { JobDetail } from '@/components/job-detail';
import { useAdminEvents } from '../lib/use-admin-events.js';
import { PipelinesPane } from '../components/PipelinesPane.jsx';

export function QueuesView({ apiUrl, apiKey, queueHealth, sseConnected }) {
  const [selectedQueue, setSelectedQueue] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem('devpanel_admin_key') || '');
  useEffect(() => { localStorage.setItem('devpanel_admin_key', adminKey); }, [adminKey]);
  const liveEvents = useAdminEvents(adminKey);

  const queues = queueHealth?.queues || [];
  const isUnreachable = !queueHealth || queueHealth.status === 'unreachable';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="flex items-center gap-3 px-6 h-14 border-b border-[var(--color-border-subtle)] shrink-0">
        <h1 className="text-[15px] font-semibold tracking-tight">Queues</h1>
        <span className="text-[12px] text-[var(--color-foreground-faint)]">BullMQ workers + pipelines</span>
        <div className="flex-1" />
        <span className="flex items-center gap-2 text-[11.5px] font-mono text-[var(--color-foreground-faint)]">
          <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-[var(--color-success)] animate-glow-pulse' : 'bg-[var(--color-error)]'}`} />
          {sseConnected ? 'live' : 'disconnected'}
        </span>
      </div>

      {isUnreachable && (
        <div
          className="mx-6 mt-4 px-4 py-3 rounded-lg flex items-center gap-3 text-[13px]"
          style={{
            background: 'var(--color-error-soft)',
            border: '1px solid var(--color-error-border)',
            color: 'var(--color-error)',
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-error)] animate-glow-pulse" />
          <span className="font-medium">Redis unreachable</span>
          <span className="opacity-70">— waiting for connection</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!isUnreachable && (
          <>
            {/* Queue cards */}
            <div className="flex gap-3 px-6 py-4 overflow-x-auto">
              {queues.map(q => (
                <QueueCard
                  key={q.queue}
                  queue={q}
                  selected={selectedQueue === q.queue.replace('devpanel:', '')}
                  onSelect={setSelectedQueue}
                  apiUrl={apiUrl}
                  adminKey={adminKey}
                />
              ))}
            </div>

            {selectedQueue && (
              <div className="flex gap-4 px-6 pb-4 min-h-[400px]">
                <div className="w-[400px] shrink-0 overflow-hidden">
                  <JobList queueName={selectedQueue} apiUrl={apiUrl} apiKey={apiKey} onSelectJob={setSelectedJob} />
                </div>
                {selectedJob && (
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <JobDetail
                      queueName={selectedQueue}
                      jobId={selectedJob.id}
                      apiUrl={apiUrl}
                      apiKey={apiKey}
                      adminKey={adminKey}
                      onClose={() => setSelectedJob(null)}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Pipelines */}
        <section className="px-6 pt-2">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)]">Pipelines</h2>
          </div>
          <div className="surface p-3">
            <PipelinesPane adminKey={adminKey} />
          </div>
        </section>

        {/* Live events */}
        <section className="px-6 py-4">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-foreground-muted)]">Live events</h2>
            <input
              type="password"
              placeholder="Admin key"
              value={adminKey}
              onChange={e => setAdminKey(e.target.value)}
              className="input flex-1 max-w-md font-mono"
            />
            <span className="text-[11.5px] text-[var(--color-foreground-faint)] font-mono">
              {adminKey ? `${liveEvents.length} events` : 'paste key to stream'}
            </span>
          </div>
          {adminKey && (
            <ul className="terminal-pane max-h-72 overflow-y-auto space-y-0.5">
              {liveEvents.length === 0 && (
                <li className="opacity-50">waiting for events…</li>
              )}
              {liveEvents.map((e, i) => (
                <li key={i} className="py-0.5">
                  <code className="text-[var(--color-info)]">{e.type}</code>{' '}
                  <span className="opacity-70">{JSON.stringify(e.data)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
