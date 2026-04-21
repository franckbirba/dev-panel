// src/dashboard/components/priority-buttons.jsx
import { useState } from 'react';

const LANES = [
  { id: 'now', color: 'bg-error', label: 'Now' },
  { id: 'today', color: 'bg-warning', label: 'Today' },
  { id: 'later', color: 'bg-muted-foreground', label: 'Later' },
];

export function PriorityButtons({ current, onSet, disabled }) {
  const [optimistic, setOptimistic] = useState(null);
  const active = optimistic ?? current;

  async function handleClick(lane) {
    const next = active === lane ? null : lane;
    setOptimistic(next);
    try {
      await onSet(next);
    } catch {
      setOptimistic(null);
    }
  }

  return (
    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
      {LANES.map(l => (
        <button
          key={l.id}
          onClick={() => handleClick(l.id)}
          disabled={disabled}
          title={l.label}
          className={`w-3.5 h-3.5 rounded-full border transition-all cursor-pointer disabled:cursor-default ${
            active === l.id
              ? `${l.color} border-transparent scale-110`
              : `border-border hover:border-muted-foreground/60`
          }`}
        />
      ))}
    </div>
  );
}
