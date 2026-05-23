import type { Session, TokenRollup } from "../../types.ts";

export function SessionCard({ s, r }: { s: Session; r: TokenRollup | null }) {
  const total = r ? (r.input_tokens + r.output_tokens + r.cache_read_tokens) : 0;
  const ctx = Math.min(100, (total / 200_000) * 100); // 200k context window heuristic
  return (
    <div className={`card ${s.status}`}>
      <div className="head"><div className="name">{s.display_name ?? s.branch ?? s.id.slice(-8)}</div>
                            <div className="meta">{s.status}</div></div>
      <div className="meta">{s.branch ?? "—"} · {(total/1000).toFixed(0)}k tok · ${(r?.cost_usd ?? 0).toFixed(2)}</div>
      <div className="bar"><div style={{ width: `${ctx}%` }} /></div>
    </div>
  );
}
