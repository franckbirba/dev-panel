// LoginView — 2FA via Telegram. POST /auth/start asks the server to push a
// code to Shelly. The server returns ONLY a challenge_id (not the code).
// Franck reads the code in Telegram and types it here. POST /auth/redeem
// validates and the server sets the session cookie.
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
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const inputRef = useRef(null);
  const tickRef = useRef(null);
  const statusPollRef = useRef(null);

  async function start() {
    setError(null);
    setCode('');
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
      setTimeout(() => inputRef.current?.focus(), 50);
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

  // Background poll: detect if Shelly denies the challenge from Telegram.
  useEffect(() => {
    if (!challenge) return;
    statusPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `${apiUrl}/auth/status?challenge_id=${challenge.challenge_id}`,
          { credentials: 'include' }
        );
        const data = await res.json();
        if (data.state === 'denied') {
          clearInterval(statusPollRef.current);
          clearInterval(tickRef.current);
          setError('Login refusé depuis Telegram');
        } else if (data.state === 'expired') {
          clearInterval(statusPollRef.current);
        }
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(statusPollRef.current);
  }, [challenge, apiUrl]);

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!challenge || code.length !== 6 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/auth/redeem`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge_id: challenge.challenge_id, code })
      });
      const data = await res.json();
      if (data.ok) {
        clearInterval(tickRef.current);
        clearInterval(statusPollRef.current);
        window.location.reload();
        return;
      }
      const msg = {
        invalid_code: data.attempts_left != null
          ? `Code incorrect (${data.attempts_left} essai${data.attempts_left > 1 ? 's' : ''} restant)`
          : 'Code incorrect',
        expired: 'Code expiré, génère-en un nouveau',
        denied: 'Login refusé depuis Telegram',
        too_many_attempts: 'Trop de tentatives, génère-en un nouveau',
        missing_fields: 'Code manquant'
      }[data.reason] || data.reason || 'Erreur inconnue';
      setError(msg);
      setCode('');
      inputRef.current?.focus();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  // Auto-submit when 6 digits are typed.
  useEffect(() => {
    if (code.length === 6 && challenge && !submitting) handleSubmit();
  }, [code]);

  function onCodeChange(v) {
    const digits = v.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
  }

  const expired = secondsLeft === 0;

  return (
    <div className="login-bg flex items-center justify-center h-screen relative overflow-hidden">
      <div className="orb" style={{ width: 400, height: 400, top: '10%', left: '15%', background: 'rgba(99, 102, 241, 0.08)' }} />
      <div className="orb" style={{ width: 300, height: 300, bottom: '20%', right: '10%', background: 'rgba(52, 211, 153, 0.06)', animationDelay: '-4s' }} />

      <form onSubmit={handleSubmit} className="login-card flex flex-col gap-5 p-8 rounded-2xl max-w-md w-full relative z-10 animate-scale-in text-center">
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Login dashboard</h2>
          <p className="text-[13px] text-muted-foreground">
            Shelly vient de t'envoyer un code en Telegram.
            <br />Tape-le ci-dessous pour te connecter.
          </p>
        </div>

        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={e => onCodeChange(e.target.value)}
          disabled={!challenge || expired || submitting}
          className="h-16 px-4 rounded-xl border border-border bg-background/50 text-foreground font-mono text-3xl text-center tracking-[0.3em] input-glow transition-all placeholder:text-muted-foreground/20 disabled:opacity-50"
          autoFocus
        />

        <button
          type="submit"
          disabled={code.length !== 6 || submitting || expired}
          className="h-11 rounded-xl bg-brand text-brand-foreground text-sm font-medium hover:bg-brand/90 transition-all cursor-pointer shadow-lg shadow-brand/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Vérification…' : 'Valider'}
        </button>

        <div className="text-[12px] text-muted-foreground">
          {expired
            ? 'Code expiré'
            : challenge
              ? `Expire dans ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
              : 'Génération du code…'}
        </div>

        {challenge?.notification_sent === false && (
          <div className="text-[12px] text-amber-500">
            Shelly n'a pas pu être notifiée. Vérifie ta config Telegram.
          </div>
        )}

        {error && <div className="text-[12px] text-red-500">{error}</div>}

        {expired && (
          <button
            type="button"
            onClick={start}
            className="h-10 rounded-xl border border-border text-sm hover:bg-accent transition-all cursor-pointer"
          >
            Renvoyer un nouveau code
          </button>
        )}
      </form>
    </div>
  );
}
