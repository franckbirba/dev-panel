// src/dashboard/components/priority-buttons.jsx
import { useState } from 'react';

const LANES = [
  { id: 'now', color: 'bg-error', glowColor: 'rgba(248, 113, 113, 0.3)', label: 'Now — needs your attention immediately' },
  { id: 'today', color: 'bg-warning', glowColor: 'rgba(251, 191, 36, 0.3)', label: 'Today — handle before end of day' },
  { id: 'later', color: 'bg-muted-foreground/60', glowColor: 'rgba(144, 144, 168, 0.2)', label: 'Later — can wait' },
];

export function PriorityButtons({ current, onSet, disabled }) {
  const [optimistic, setOptimistic] = useState(null);
  const [justChanged, setJustChanged] = useState(null);
  const active = optimistic ?? current;

  async function handleClick(lane) {
    const next = active === lane ? null : lane;
    setOptimistic(next);
    setJustChanged(next);
    setTimeout(() => setJustChanged(null), 600);
    try {
      await onSet(next);
    } catch {
      setOptimistic(null);
    }
  }

  return (
    <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
      {LANES.map(l => (
        <button
          key={l.id}
          onClick={() => handleClick(l.id)}
          disabled={disabled}
          title={l.label}
          className={`w-4 h-4 rounded-full border-2 transition-all duration-200 cursor-pointer disabled:cursor-default ${
            active === l.id
              ? `${l.color} border-transparent scale-125`
              : `border-border/60 hover:border-muted-foreground/40 hover:scale-110`
          }`}
          style={active === l.id ? { boxShadow: `0 0 8px ${l.glowColor}` } : undefined}
        />
      ))}
    </div>
  );
}
