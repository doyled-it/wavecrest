import { useEffect, useState } from "react";
import type { Session, TokenRollup, SubagentSlice, DiffStats } from "../../types.ts";

// Deterministic color from a string — same input always picks the same hue.
// Used so subagent pills are visually stable across renders/sessions.
function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue} 65% 55%)`;
}

function SubagentPills({ slices }: { slices: SubagentSlice[] }) {
  if (!slices || slices.length === 0) return null;
  const total = slices.reduce((acc, s) => acc + s.total_tokens, 0);
  if (total === 0) return null;
  // Drop slices that round to <1% to keep the row tidy.
  const visible = slices.filter(s => (s.total_tokens / total) * 100 >= 1);
  if (visible.length === 0) return null;
  return (
    <div className="subagent-pills" title="token share by subagent">
      {visible.map(s => {
        const pct = Math.round((s.total_tokens / total) * 100);
        const color = s.subagent_type === "main" ? "var(--muted)" : hashColor(s.subagent_type);
        return (
          <span key={s.subagent_type} className="subagent-pill" style={{ borderColor: color, color }}>
            {s.subagent_type} {pct}%
          </span>
        );
      })}
    </div>
  );
}

// Tiny SVG sparkline. Fixed viewBox so CSS controls render size; the path
// auto-scales to the data range. Zero-only data returns null (no visual).
function Sparkline({ values, width = 120, height = 18 }: { values: number[]; width?: number; height?: number }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values);
  if (max === 0) return null;
  const stepX = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export function SessionCard({
  s,
  r,
  breakdown,
  sparkline,
  diff,
}: {
  s: Session;
  r: TokenRollup | null;
  breakdown: SubagentSlice[];
  sparkline: number[];
  diff: DiffStats | null;
}) {
  const turn = r ? (r.input_tokens + r.output_tokens) : 0;
  const cached = r ? r.cache_read_tokens : 0;
  const now = useNow();
  const sinceMs = Math.max(0, now - s.last_active_at);
  const sinceLabel = fmtDuration(sinceMs);

  // Display fallback chain: explicit name → repo basename → cwd basename → id slice.
  // Branch shown below in meta row, so it's redundant in the title.
  function basename(p: string | null | undefined): string | null {
    if (!p) return null;
    const parts = p.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? null;
  }
  const displayName = s.display_name ?? basename(s.repo_root) ?? basename(s.cwd) ?? s.id.slice(-8);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [busy, setBusy] = useState(false);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(displayName);
    setEditing(true);
  };

  const save = async () => {
    if (busy) return;
    if (draft.trim() === displayName) { setEditing(false); return; }
    setBusy(true);
    try {
      await fetch(`/api/sessions/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: draft }),
      });
    } catch { /* silent — SSE will refresh or not */ }
    setEditing(false);
    setBusy(false);
  };

  const cancel = () => { setEditing(false); setDraft(displayName); };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  };

  // NOTE: tab focus from outside the current tab is blocked upstream — wsh has no
  // `tab focus` command and `focusblock` only works within the current tab. Tracked
  // for the upstream PR alongside `tab create` and `tab rename`. Cards are non-
  // clickable for now to avoid false hover affordance.

  return (
    <div
      className={`card ${s.status}`}
      title={`session ${s.id}`}
    >
      <div className="head">
        {editing ? (
          <input
            autoFocus
            className="name-edit"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={onKey}
            disabled={busy}
          />
        ) : (
          <div className="name" onClick={startEdit} title="click to rename">{displayName}</div>
        )}
        <div className="head-right">
          <span className="meta">{s.status} · {sinceLabel}</span>
          <button
            type="button"
            className={`card-pin ${s.pinned ? "is-pinned" : ""}`}
            title={s.pinned ? "unpin" : "pin to top"}
            onClick={async (e) => {
              e.stopPropagation();
              await fetch(`/api/sessions/${s.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pinned: !s.pinned }),
              });
            }}
          >{s.pinned ? "★" : "☆"}</button>
          <button
            type="button"
            className="card-delete"
            title="delete session"
            onClick={async (e) => {
              e.stopPropagation();
              if (!confirm(`Delete session "${displayName}"?\n\nThis removes its row from wavecrest. The actual claude process and Wave block are not affected — close those yourself if needed.`)) return;
              await fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
            }}
          >×</button>
        </div>
      </div>
      <div className="meta">
        {s.worktree_path ? <span title={`worktree: ${s.worktree_path}`}>⎇ </span> : null}
        {s.branch ?? "—"} · {fmtTokens(turn)} tok
        {cached > 1000 ? <span title="cumulative cache reads"> · {fmtTokens(cached)} cached</span> : null}
        {(r?.cost_usd ?? 0) > 0 ? <span> · ${(r?.cost_usd ?? 0).toFixed(2)}</span> : null}
        {diff && (diff.insertions > 0 || diff.deletions > 0) ? (
          <span title={`vs merge-base ${diff.base} · ${diff.files} file${diff.files === 1 ? "" : "s"}`}>
            {" · "}<span style={{ color: "var(--ok)" }}>+{diff.insertions}</span>
            {" "}<span style={{ color: "var(--bad)" }}>−{diff.deletions}</span>
          </span>
        ) : null}
      </div>
      <SubagentPills slices={breakdown} />
      <Sparkline values={sparkline} />
    </div>
  );
}
