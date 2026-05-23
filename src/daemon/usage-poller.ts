// src/daemon/usage-poller.ts
import type { Database } from "bun:sqlite";
import { allAdapters } from "../adapters/registry.ts";
import { insertUsageSnapshot } from "../db/queries.ts";
import { broadcast } from "./sse.ts";
import { log } from "../lib/logger.ts";

const INTERVAL_MS = 30_000;

export interface Poller {
  stop(): void;
}

export function startUsagePoller(db: Database): Poller {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    for (const a of allAdapters()) {
      if (!a.accountUsage) continue;
      try {
        const snaps = await a.accountUsage();
        for (const s of snaps) insertUsageSnapshot(db, s);
        broadcast("usage", { kind: a.kind });
      } catch (e) {
        log.warn("usage poll error", { kind: a.kind, error: String(e) });
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
