export function RingGauge({ percent, color, label }: { percent: number; color: string; label: string }) {
  const c = Math.min(100, Math.max(0, percent));
  const dash = 125.6;
  const offset = dash * (1 - c / 100);
  return (
    <div className="gauge">
      <svg width="56" height="56" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="20" fill="none" stroke="#414868" strokeWidth="4" />
        <circle cx="24" cy="24" r="20" fill="none" stroke={color} strokeWidth="4"
                strokeDasharray={dash} strokeDashoffset={offset} transform="rotate(-90 24 24)" />
      </svg>
      <div className="label">{label}<br/>{Math.round(c)}%</div>
    </div>
  );
}
