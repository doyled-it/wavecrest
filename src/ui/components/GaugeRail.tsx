import { useEffect, useState } from "react";
import { RingGauge } from "./RingGauge.tsx";
import type { UsageSnapshot } from "../../types.ts";

function pct(s?: UsageSnapshot): number { return s ? (s.used / s.limit) * 100 : 0; }
function colorFor(p: number): string { return p >= 80 ? "var(--bad)" : p >= 60 ? "var(--warn)" : "var(--ok)"; }

/** "in 2h 14m" / "in 47m" / "in 23s" — null if no resets_at. */
function countdown(resetsAt: number | null | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt - now;
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function GaugeWithReset({ snapshot, label, now }: { snapshot?: UsageSnapshot; label: string; now: number }) {
  const p = pct(snapshot);
  const c = colorFor(p);
  const cd = countdown(snapshot?.resets_at, now);
  const subtitle = cd
    ? `in ${cd}`
    : (snapshot?.resets_text ?? null);
  return (
    <div className="gauge-with-reset">
      <RingGauge percent={p} color={c} label={label} />
      {subtitle ? <div className="gauge-reset" title={snapshot?.resets_text ?? ""}>{subtitle}</div> : null}
    </div>
  );
}

export function GaugeRail({ usage }: { usage: UsageSnapshot[] }) {
  const session = usage.find(u => u.scope === "session");
  const weekly  = usage.find(u => u.scope === "weekly" && !u.scope_key);
  const opus    = usage.find(u => u.scope === "model" && u.scope_key?.toLowerCase().includes("opus"));

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rail">
      <GaugeWithReset snapshot={session} label="Session" now={now} />
      <GaugeWithReset snapshot={weekly}  label="Week"    now={now} />
      <GaugeWithReset snapshot={opus}    label="Opus"    now={now} />
    </div>
  );
}
