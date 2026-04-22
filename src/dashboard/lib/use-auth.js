// Probes /auth/me to detect whether the browser already has a valid Lucia
// session cookie. Used by the dashboard root to decide between LoginView
// and the actual dashboard.
import { useState, useEffect, useCallback } from 'react';

export function useAuth(apiUrl = '') {
  const [status, setStatus] = useState('unknown'); // unknown | authenticated | unauthenticated

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/auth/me`, { credentials: 'include' });
      const data = await res.json();
      setStatus(data.authenticated ? 'authenticated' : 'unauthenticated');
    } catch {
      setStatus('unauthenticated');
    }
  }, [apiUrl]);

  useEffect(() => { refresh(); }, [refresh]);

  return { status, refresh };
}
