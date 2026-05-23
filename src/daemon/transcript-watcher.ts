import chokidar from "chokidar";
import { stat, open } from "fs/promises";
import type { Database } from "bun:sqlite";
import { findSessionByAgentSessionId, upsertRollup } from "../db/queries.ts";
import { log } from "../lib/logger.ts";
import { broadcast } from "./sse.ts";

interface Tailer {
  offset: number;
  sessionId: string | null;
  transcriptPath: string;
}

export interface Watcher {
  stop(): void;
}

export function startTranscriptWatcher(db: Database, roots: string[]): Watcher {
  // Per-watcher state — each call gets a fresh map to avoid cross-test leakage.
  const tailers = new Map<string, Tailer>();
  // Per-file serialization locks to prevent double-counting from concurrent chokidar fires.
  const locks = new Map<string, Promise<void>>();

  const handleFile = async (path: string): Promise<void> => {
    if (!path.endsWith(".jsonl")) return;

    let t = tailers.get(path);
    if (!t) {
      t = { offset: 0, sessionId: null, transcriptPath: path };
      tailers.set(path, t);
    }

    const st = await stat(path).catch(() => null);
    if (!st) return;
    if (st.size <= t.offset) return;

    const fh = await open(path, "r");
    try {
      const length = st.size - t.offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, t.offset);
      t.offset = st.size;
      const lines = buf.toString("utf8").split("\n").filter(Boolean);

      for (const line of lines) {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // silently skip malformed JSON
        }

        // Try to resolve session_id from multiple possible locations in the entry
        const agentSid: string | undefined =
          (typeof entry.session_id === "string" ? entry.session_id : undefined) ??
          (typeof (entry as any).sessionId === "string" ? (entry as any).sessionId : undefined) ??
          (typeof (entry.message as any)?.session_id === "string"
            ? (entry.message as any).session_id
            : undefined);

        if (agentSid && !t.sessionId) {
          const sess = findSessionByAgentSessionId(db, agentSid);
          if (sess) t.sessionId = sess.id;
        }

        const message = entry.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;

        if (usage && t.sessionId) {
          upsertRollup(db, {
            session_id: t.sessionId,
            input_tokens: (usage.input_tokens as number) ?? 0,
            output_tokens: (usage.output_tokens as number) ?? 0,
            cache_read_tokens: (usage.cache_read_input_tokens as number) ?? 0,
            cache_write_tokens: (usage.cache_creation_input_tokens as number) ?? 0,
            cost_usd: 0,
            updated_at: Date.now(),
          });
          broadcast("rollup", { session_id: t.sessionId });
        }
      }
    } finally {
      await fh.close();
    }
  };

  // Serialize concurrent chokidar events for the same file via promise chaining.
  const handle = (path: string): void => {
    const prev = locks.get(path) ?? Promise.resolve();
    const next = prev.then(() => handleFile(path)).catch((e) => {
      log.warn("transcript-watcher: error processing file", { path, error: String(e) });
    });
    locks.set(path, next);
  };

  const watcher = chokidar.watch(roots, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher
    .on("add", handle)
    .on("change", handle)
    .on("error", (e) => log.warn("transcript-watcher: watcher error", { error: String(e) }));

  return {
    stop() {
      void watcher.close();
      tailers.clear();
      locks.clear();
    },
  };
}
