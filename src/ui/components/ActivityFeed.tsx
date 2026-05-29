import { useEffect, useState } from "react";

interface EventRow {
  id: number;
  session_id: string;
  ts: number;
  kind: string;
  status_after: string | null;
  status_before: string | null;
  session_display: string | null;
  session_branch: string | null;
  session_cwd: string;
}

function fmtSince(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function statusColor(s: string | null): string {
  switch (s) {
    case "working":  return "var(--ok)";
    case "awaiting": return "var(--warn)";
    case "idle":     return "var(--muted)";
    case "finished": return "var(--muted)";
    case "error":
    case "crashed":  return "var(--bad)";
    default:         return "var(--muted)";
  }
}

function cwdBase(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[parts.length - 2] === ".worktrees") {
    return parts[parts.length - 1] ?? p;
  }
  return parts[parts.length - 1] ?? p;
}

export function ActivityFeed() {
  const [open, setOpen] = useState(false);
  const [verbose, setVerbose] = useState(false);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => fetch(`/api/events/recent?limit=80${verbose ? "&verbose=1" : ""}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setEvents(d); })
      .catch(() => {});
    load();
    const sse = new EventSource("/api/events");
    sse.addEventListener("session", load);
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => { cancelled = true; sse.close(); clearInterval(tick); };
  }, [open, verbose]);

  return (
    <div className={`feed ${open ? "open" : ""}`}>
      <div className="feed-header">
        <button
          type="button"
          className="feed-toggle"
          onClick={() => setOpen(v => !v)}
          title="recent hook events from all agent sessions"
        >
          {open ? "▾" : "▸"} activity
        </button>
        {open ? (
          <label className="feed-verbose" title="also include per-tool-call events (noisy)">
            <input type="checkbox" checked={verbose} onChange={e => setVerbose(e.target.checked)} />
            verbose
          </label>
        ) : null}
      </div>
      {open ? (
        <div className="feed-list">
          {events.length === 0
            ? <div className="feed-empty">(no events yet)</div>
            : events.map(e => {
                const name = e.session_display ?? e.session_branch ?? cwdBase(e.session_cwd);
                const from = e.status_before || "—";
                const to = e.status_after ?? e.kind;
                const color = statusColor(e.status_after);
                return (
                  <div key={e.id} className="feed-row">
                    <span className="feed-time">{fmtSince(Math.max(0, now - e.ts))}</span>
                    <span className="feed-dot" style={{ background: color }} />
                    <span className="feed-name">{name}</span>
                    {e.status_after ? (
                      <span className="feed-verb">
                        <span className="feed-from">{from}</span>
                        <span className="feed-arrow"> → </span>
                        <span className="feed-to" style={{ color }}>{to}</span>
                      </span>
                    ) : (
                      <span className="feed-verb">{e.kind}</span>
                    )}
                  </div>
                );
              })}
        </div>
      ) : null}
    </div>
  );
}
