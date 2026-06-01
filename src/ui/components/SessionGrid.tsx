import { SessionCard } from "./SessionCard.tsx";
import type { Session, TokenRollup, SubagentSlice, DiffStats } from "../../types.ts";

export type EnrichedSession = Session & {
  rollup: TokenRollup | null;
  subagent_breakdown?: SubagentSlice[];
  token_sparkline?: number[];
  diff_stats?: DiffStats | null;
};

export function SessionGrid({ sessions }: { sessions: EnrichedSession[] }) {
  if (sessions.length === 0) return <div style={{ color: "var(--muted)" }}>(no active sessions)</div>;
  return (
    <div className="grid">
      {sessions.map(s => (
        <SessionCard
          key={s.id}
          s={s}
          r={s.rollup}
          breakdown={s.subagent_breakdown ?? []}
          sparkline={s.token_sparkline ?? []}
          diff={s.diff_stats ?? null}
        />
      ))}
    </div>
  );
}
