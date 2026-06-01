import { SessionCard } from "./SessionCard.tsx";
import type { Session, TokenRollup, SubagentSlice, DiffStats } from "../../types.ts";

export type EnrichedSession = Session & {
  rollup: TokenRollup | null;
  subagent_breakdown?: SubagentSlice[];
  token_sparkline?: number[];
  diff_stats?: DiffStats | null;
};

// Same fallback chain SessionCard uses for its title. Kept here for sorting
// so the visible alphabetical order always matches the visible names.
function sortKey(s: Session): string {
  const basename = (p: string | null | undefined): string | null => {
    if (!p) return null;
    const parts = p.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? null;
  };
  return (s.display_name ?? basename(s.repo_root) ?? basename(s.cwd) ?? s.id).toLowerCase();
}

export function SessionGrid({ sessions }: { sessions: EnrichedSession[] }) {
  if (sessions.length === 0) return <div style={{ color: "var(--muted)" }}>(no active sessions)</div>;
  const ordered = [...sessions].sort((a, b) => {
    // Pinned float to top; within each group, alphabetical by visible name.
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return sortKey(a).localeCompare(sortKey(b));
  });
  return (
    <div className="grid">
      {ordered.map(s => (
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
