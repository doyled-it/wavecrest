import { RingGauge } from "./RingGauge.tsx";
import type { UsageSnapshot } from "../../types.ts";

function pct(s?: UsageSnapshot): number { return s ? (s.used / s.limit) * 100 : 0; }
function colorFor(p: number): string { return p >= 80 ? "#f7768e" : p >= 60 ? "#e0af68" : "#9ece6a"; }

export function GaugeRail({ usage }: { usage: UsageSnapshot[] }) {
  const session = usage.find(u => u.scope === "session");
  const weekly  = usage.find(u => u.scope === "weekly" && !u.scope_key);
  const opus    = usage.find(u => u.scope === "model" && u.scope_key?.toLowerCase().includes("opus"));
  return (
    <div className="rail">
      <RingGauge percent={pct(session)} color={colorFor(pct(session))} label="Session" />
      <RingGauge percent={pct(weekly)}  color={colorFor(pct(weekly))}  label="Week"   />
      <RingGauge percent={pct(opus)}    color={colorFor(pct(opus))}    label="Opus"   />
    </div>
  );
}
