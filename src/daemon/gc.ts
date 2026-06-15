// src/daemon/gc.ts
//
// Session garbage collection. Two jobs run on a timer so the session table (and
// its cascaded events/samples) stays bounded no matter how many short-lived
// `claude` invocations fire hooks:
//
//   1. Reap zombies   — non-terminal sessions whose process died without firing
//                        a SessionEnd hook. After STALE_REAP_MS of silence they
//                        are marked 'finished' and drop off the dashboard.
//   2. Delete history — 'finished' sessions older than RETENTION_MS are removed
//                        entirely (FK cascade clears their events/rollup/samples).
//
import type { Database } from "bun:sqlite";
import { deleteFinishedSessionsOlderThan, reapStaleSessions } from "../db/queries.ts";
import { broadcast } from "./sse.ts";
import { log } from "../lib/logger.ts";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // keep finished sessions 7 days
export const STALE_REAP_MS = 24 * 60 * 60 * 1000;    // reap non-terminal sessions idle > 24h
const GC_INTERVAL_MS = 60 * 60 * 1000;               // sweep hourly

export interface Gc {
  stop(): void;
}

/** Run one GC pass: reap zombies, then delete aged-out finished rows. `now` is
 *  injectable for tests. Broadcasts a `session` event if anything changed so
 *  connected dashboards refetch. */
export function runGc(db: Database, now: number = Date.now()): { reaped: number; deleted: number } {
  const reaped = reapStaleSessions(db, now - STALE_REAP_MS);
  const deleted = deleteFinishedSessionsOlderThan(db, now - RETENTION_MS);
  if (reaped > 0 || deleted > 0) {
    log.info("gc: swept sessions", { reaped, deleted });
    broadcast("session", { gc: true });
  }
  return { reaped, deleted };
}

export function startGc(db: Database): Gc {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = () => {
    if (stopped) return;
    try {
      runGc(db);
    } catch (e) {
      log.warn("gc: sweep failed (non-fatal)", { error: String(e) });
    }
    if (!stopped) timer = setTimeout(tick, GC_INTERVAL_MS);
  };

  // First sweep shortly after boot (clears zombies left by a previous run),
  // then hourly.
  timer = setTimeout(tick, 5_000);

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
