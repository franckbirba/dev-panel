export function MetricCard({ label, value, delta }) {
  return (
    <div className="card-glow flex-1 min-w-[180px] rounded-xl p-5 flex flex-col gap-2">
      <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{label}</span>
      <span className="text-foreground text-3xl font-bold tracking-tight leading-none">{value}</span>
      <span className="text-muted-foreground/60 text-[11px] font-mono">{delta}</span>
    </div>
  );
}
