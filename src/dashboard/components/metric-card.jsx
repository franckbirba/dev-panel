import { useEffect, useRef, useState } from 'react';

function AnimatedNumber({ value }) {
  const ref = useRef(null);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const num = parseInt(value, 10);
    if (isNaN(num)) { setDisplay(value); return; }
    const prev = parseInt(display, 10) || 0;
    if (prev === num) return;
    const diff = num - prev;
    const steps = Math.min(Math.abs(diff), 20);
    const duration = 400;
    const stepTime = duration / steps;
    let current = prev;
    const dir = diff > 0 ? 1 : -1;
    const increment = Math.max(1, Math.floor(Math.abs(diff) / steps));
    const timer = setInterval(() => {
      current += dir * increment;
      if ((dir > 0 && current >= num) || (dir < 0 && current <= num)) {
        current = num;
        clearInterval(timer);
      }
      setDisplay(String(current));
    }, stepTime);
    return () => clearInterval(timer);
  }, [value]);

  return <span>{display}</span>;
}

export function MetricCard({ label, value, delta, accent }) {
  return (
    <div className="glass-card rounded-xl p-5 flex flex-col gap-2 animate-fade-in-up">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground/50 text-[10px] font-medium tracking-widest uppercase">{label}</span>
      </div>
      <span className={`text-3xl font-bold tracking-tight leading-none ${accent || 'text-foreground'}`}>
        <AnimatedNumber value={value} />
      </span>
      <span className="text-muted-foreground/40 text-[11px] font-mono">{delta}</span>
    </div>
  );
}
