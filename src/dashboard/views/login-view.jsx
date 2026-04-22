// LoginView — 2FA via Telegram. POST /auth/start, show 6-digit code, poll
// /auth/check until Shelly relays Franck's confirmation, then reload.
import { useState, useEffect, useRef } from 'react';

function detectClient() {
  const ua = navigator.userAgent;
  const browser = /Edg/i.test(ua) ? 'Edge'
    : /Chrome/i.test(ua) ? 'Chrome'
    : /Firefox/i.test(ua) ? 'Firefox'
    : /Safari/i.test(ua) ? 'Safari'
    : 'Browser';
  const os = /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Mac/i.test(ua) ? 'Mac'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown';
  return `${browser} on ${os}`;
}

export function LoginView({ apiUrl = '' }) {
  const [challenge, setChallenge] = useState(null);
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pollRef = useRef(null);
  const tickRef = useRef(null);

  async function start() {
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/auth/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_hint: detectClient() })
      });
      if (!res.ok) throw new Error(`start failed (${res.status})`);
      const data = await res.json();
      setChallenge(data);
      setSecondsLeft(data.ttl);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { start(); }, []);

  useEffect(() => {
    if (!challenge) return;
    tickRef.current = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { clearInterval(tickRef.current); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [challenge]);

  useEffect(() => {
    if (!challenge) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `${apiUrl}/auth/check?code=${challenge.code}`,
          { credentials: 'include' }
        );
        const data = await res.json();
        if (data.ok) {
          clearInterval(pollRef.current);
          clearInterval(tickRef.current);
          window.location.reload();
        } else if (data.state === 'unknown') {
          clearInterval(pollRef.current);
          setError('Login refusé ou expiré');
        }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [challenge, apiUrl]);

  const codeFormatted = challenge?.code
    ? challenge.code.match(/.{1,3}/g).join(' ')
    : '— — — — — —';

  return (
    <div className="login-bg flex items-center justify-center h-screen relative overflow-hidden">
      <div className="orb" style={{ width: 400, height: 400, top: '10%', left: '15%', background: 'rgba(99, 102, 241, 0.08)' }} />
      <div className="orb" style={{ width: 300, height: 300, bottom: '20%', right: '10%', background: 'rgba(52, 211, 153, 0.06)', animationDelay: '-4s' }} />

      <div className="login-card flex flex-col gap-6 p-8 rounded-2xl max-w-md w-full relative z-10 animate-scale-in text-center">
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Login dashboard</h2>
          <p className="text-[13px] text-muted-foreground">
            Shelly t'a envoyé un code en Telegram. Tape-le pour valider.
          </p>
        </div>

        <div className="font-mono text-4xl tracking-[0.3em] text-foreground py-4">
          {codeFormatted}
        </div>

        <div className="text-[12px] text-muted-foreground">
          {secondsLeft > 0
            ? `Expire dans ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
            : 'Expiré'}
        </div>

        {challenge?.notification_sent === false && (
          <div className="text-[12px] text-amber-500">
            Shelly n'a pas pu être notifiée. Envoie le code manuellement en Telegram.
          </div>
        )}

        {error && <div className="text-[12px] text-red-500">{error}</div>}

        <button
          onClick={start}
          className="h-10 rounded-xl border border-border text-sm hover:bg-accent transition-all cursor-pointer"
        >
          Renvoyer le code
        </button>
      </div>
    </div>
  );
}
