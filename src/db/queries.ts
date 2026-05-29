import type { Database } from "bun:sqlite";
import type { Session, SessionStatus, Event, UsageSnapshot, TokenRollup } from "../types.ts";

export function insertSession(db: Database, s: Session): void {
  db.query(`INSERT INTO sessions
    (id, agent_kind, agent_session_id, workspace_id, wave_tab_id, wave_block_id,
     cwd, repo_root, branch, worktree_path, launch_argv, display_name,
     status, auto_resume, pinned, created_at, last_active_at, transcript_path)
    VALUES ($id,$kind,$asid,$ws,$tab,$blk,$cwd,$repo,$branch,$wt,$argv,$name,
            $status,$ar,$pinned,$ca,$la,$tp)`).run({
    $id: s.id, $kind: s.agent_kind, $asid: s.agent_session_id ?? null,
    $ws: s.workspace_id ?? null, $tab: s.wave_tab_id ?? null, $blk: s.wave_block_id ?? null,
    $cwd: s.cwd, $repo: s.repo_root ?? null, $branch: s.branch ?? null,
    $wt: s.worktree_path ?? null, $argv: JSON.stringify(s.launch_argv),
    $name: s.display_name ?? null, $status: s.status,
    $ar: s.auto_resume ? 1 : 0, $pinned: s.pinned ? 1 : 0,
    $ca: s.created_at, $la: s.last_active_at, $tp: s.transcript_path ?? null,
  });
}

export function updateSessionStatus(db: Database, id: string, status: SessionStatus, ts: number): void {
  db.query("UPDATE sessions SET status=?, last_active_at=? WHERE id=?").run(status, ts, id);
}

export function listActiveSessions(db: Database): Session[] {
  const rows = db.query("SELECT * FROM sessions WHERE status != 'finished' ORDER BY last_active_at DESC").all() as any[];
  return rows.map(rowToSession);
}

export function getSession(db: Database, id: string): Session | null {
  const r = db.query("SELECT * FROM sessions WHERE id=?").get(id) as any;
  return r ? rowToSession(r) : null;
}

export function findSessionByAgentSessionId(db: Database, agentSessionId: string): Session | null {
  const r = db.query("SELECT * FROM sessions WHERE agent_session_id=?").get(agentSessionId) as any;
  return r ? rowToSession(r) : null;
}

export function insertEvent(db: Database, ev: Event): void {
  db.query("INSERT INTO events (session_id, ts, kind, payload_json) VALUES (?, ?, ?, ?)")
    .run(ev.session_id, ev.ts, ev.kind, ev.payload_json ?? null);
}

export function upsertRollup(db: Database, r: TokenRollup): void {
  db.query(`INSERT INTO session_token_rollup
    (session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      cost_usd = cost_usd + excluded.cost_usd,
      updated_at = excluded.updated_at
  `).run(r.session_id, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cost_usd, r.updated_at);
}

export function getRollup(db: Database, sessionId: string): TokenRollup | null {
  const r = db.query("SELECT * FROM session_token_rollup WHERE session_id=?").get(sessionId) as any;
  return r ?? null;
}

export function insertUsageSnapshot(db: Database, u: UsageSnapshot): void {
  db.query("INSERT INTO usage_snapshots (agent_kind, ts, scope, scope_key, used, limit_, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(u.agent_kind, u.ts, u.scope, u.scope_key ?? null, u.used, u.limit, u.resets_at ?? null);
}

export function latestUsageSnapshots(db: Database, agentKind: string): UsageSnapshot[] {
  const rows = db.query(`
    SELECT u.* FROM usage_snapshots u
    INNER JOIN (
      SELECT scope, COALESCE(scope_key,'') AS sk, MAX(id) AS maxid
      FROM usage_snapshots WHERE agent_kind=? GROUP BY scope, COALESCE(scope_key,'')
    ) latest ON latest.maxid=u.id
    WHERE u.agent_kind=?
  `).all(agentKind, agentKind) as any[];
  return rows.map(r => ({ ...r, limit: r.limit_ }));
}

// Note: 'crashed' sessions ARE returned — they're recoverable via re-launch.
// Only 'finished' (user-ended) and 'stopped' (user-killed) are excluded.
export function listResumableSessions(db: Database): Session[] {
  const rows = db.query(
    "SELECT * FROM sessions WHERE auto_resume=1 AND status NOT IN ('finished','stopped') ORDER BY last_active_at DESC"
  ).all() as any[];
  return rows.map(rowToSession);
}

/** Find a recent unbound planned session for the same cwd, so a wild adoption can merge into it. */
export function findPlannedSessionForAdoption(
  db: Database,
  cwd: string | null,
  agentKind: string,
): Session | null {
  if (!cwd) return null;
  const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes
  const r = db.query(
    `SELECT * FROM sessions
     WHERE agent_session_id IS NULL
       AND auto_resume = 1
       AND agent_kind = ?
       AND cwd = ?
       AND created_at >= ?
       AND status NOT IN ('finished','stopped','error','crashed')
     ORDER BY created_at DESC LIMIT 1`,
  ).get(agentKind, cwd, cutoff) as any;
  return r ? rowToSession(r) : null;
}

/** Adopt a planned session: stamp it with the agent's session id, transcript path, status. */
export function bindPlannedSession(
  db: Database,
  id: string,
  agentSessionId: string,
  transcriptPath: string | null,
  status: SessionStatus,
  ts: number,
): void {
  db.query(
    `UPDATE sessions SET agent_session_id = ?, transcript_path = ?, status = ?, last_active_at = ? WHERE id = ?`,
  ).run(agentSessionId, transcriptPath, status, ts, id);
}

function rowToSession(r: any): Session {
  let launch_argv: string[];
  try { launch_argv = JSON.parse(r.launch_argv); }
  catch (e) { throw new Error(`queries: malformed launch_argv for session ${r.id}: ${(e as Error).message}`); }
  return {
    id: r.id, agent_kind: r.agent_kind, agent_session_id: r.agent_session_id,
    workspace_id: r.workspace_id, wave_tab_id: r.wave_tab_id, wave_block_id: r.wave_block_id,
    cwd: r.cwd, repo_root: r.repo_root, branch: r.branch, worktree_path: r.worktree_path,
    launch_argv, display_name: r.display_name, status: r.status,
    auto_resume: !!r.auto_resume, pinned: !!r.pinned,
    created_at: r.created_at, last_active_at: r.last_active_at, transcript_path: r.transcript_path,
  };
}
