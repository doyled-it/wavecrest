import { SessionCard } from "./SessionCard.tsx";
import type { Session, TokenRollup } from "../../types.ts";

export function SessionGrid({ sessions }: { sessions: Array<Session & { rollup: TokenRollup | null }> }) {
  if (sessions.length === 0) return <div style={{ color: "var(--muted)" }}>(no active sessions)</div>;
  return (
    <div className="grid">
      {sessions.map(s => <SessionCard key={s.id} s={s} r={s.rollup} />)}
    </div>
  );
}
