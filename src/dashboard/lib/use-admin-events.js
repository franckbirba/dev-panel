// src/dashboard/lib/use-admin-events.js
import { useEffect, useState } from 'react';
import { subscribeAdminEvents } from './events.js';

export function useAdminEvents(adminKey, maxItems = 100) {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    if (!adminKey) return;
    const unsub = subscribeAdminEvents(adminKey, (type, data) => {
      setEvents(prev => [{ type, data, at: Date.now() }, ...prev].slice(0, maxItems));
    });
    return unsub;
  }, [adminKey, maxItems]);
  return events;
}
