// src/daemon/usage-poller.ts
import type { Database } from "bun:sqlite";
import { allAdapters } from "../adapters/registry.ts";
import { insertUsageSnapshot } from "../db/queries.ts";
import { broadcast } from "./sse.ts";
import { log } from "../lib/logger.ts";

const INTERVAL_MS = 30_000;
// If a single accountUsage call takes longer than this, treat the adapter as
// hung (most likely a blocked readSync on the meta-process pty) — abandon the
// call so the poller keeps ticking, and force-respawn on the next attempt.
const POLL_TIMEOUT_MS = 20_000;

export interface Poller {
  stop(): void;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(id); resolve(v); },
           e => { clearTimeout(id); reject(e); });
  });
}

export function startUsagePoller(db: Database): Poller {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Per-adapter consecutive failure count; force a reset on the adapter after
  // a couple of timeouts in a row.
  const failsByKind = new Map<string, number>();

  const tick = async () => {
    if (stopped) return;
    for (const a of allAdapters()) {
      if (!a.accountUsage) continue;
      try {
        const snaps = await withTimeout(a.accountUsage(), POLL_TIMEOUT_MS, `${a.kind} accountUsage`);
        failsByKind.set(a.kind, 0);
        if (snaps.length > 0) {
          for (const s of snaps) insertUsageSnapshot(db, s);
          broadcast("usage", { kind: a.kind });
        }
      } catch (e) {
        const fails = (failsByKind.get(a.kind) ?? 0) + 1;
        failsByKind.set(a.kind, fails);
        log.warn("usage poll error", { kind: a.kind, fails, error: String(e) });
        // After 2 consecutive failures, ask the adapter to reset its state if
        // it exposes one. Claude's usage adapter holds a module-level meta
        // process; resetting it forces a fresh spawn on the next call.
        if (fails >= 2 && typeof (a as any).resetAccountUsage === "function") {
          try {
            (a as any).resetAccountUsage();
            log.info("usage poller: forced adapter reset", { kind: a.kind });
          } catch (re) {
            log.warn("usage poller: adapter reset failed", { kind: a.kind, error: String(re) });
          }
        }
      }
    }
    if (!stopped) {
      timer = setTimeout(tick, INTERVAL_MS);
    }
  };

  timer = setTimeout(tick, 1000);

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
