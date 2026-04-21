// src/dashboard/lib/use-signals.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { subscribeAdminEvents } from './events.js';
import { getAdminKey } from './projects-store.js';

const POLL_MS = 15_000;

export function useSignals({ apiUrl, apiKey, filters = {} }) {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSignals = useCallback(async () => {
    if (!apiKey) return;
    const params = new URLSearchParams();
    if (filters.project) params.set('project_id', filters.project);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.needs_me_only) params.set('needs_me_only', '1');
    try {
      const headers = { 'X-API-Key': apiKey };
      const adminKey = getAdminKey();
      if (adminKey) headers['X-Admin-Key'] = adminKey;
      const r = await fetch(`${apiUrl}/api/signals?${params}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setSignals(data.signals || data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, apiKey, filters.project, filters.priority, filters.needs_me_only]);

  // Initial fetch + polling
  useEffect(() => { fetchSignals(); }, [fetchSignals]);
  useEffect(() => {
    const id = setInterval(fetchSignals, POLL_MS);
    return () => clearInterval(id);
  }, [fetchSignals]);

  // SSE live updates
  useEffect(() => {
    const adminKey = getAdminKey();
    if (!adminKey) return;
    const unsub = subscribeAdminEvents(adminKey, (type, data) => {
      if (type === 'signal:new') {
        setSignals(prev => [data, ...prev.filter(s =>
          !(s.subject_type === data.subject_type && s.subject_id === data.subject_id)
        )]);
      }
      if (type === 'subject:priority_changed') {
        setSignals(prev => prev.map(s =>
          s.subject_type === data.subject_type && s.subject_id === data.subject_id
            ? { ...s, priority: data.priority }
            : s
        ));
      }
      if (type === 'signal:resolved') {
        setSignals(prev => prev.filter(s =>
          !(s.subject_type === data.subject_type && s.subject_id === data.subject_id)
        ));
      }
    });
    return unsub;
  }, []);

  // Group into urgency bands
  const grouped = {
    needs_attention: signals.filter(s => s.urgency === 'needs_attention'),
    in_flight: signals.filter(s => s.urgency === 'in_flight'),
    fyi: signals.filter(s => s.urgency === 'fyi'),
  };

  return { signals, grouped, loading, error, refetch: fetchSignals };
}
