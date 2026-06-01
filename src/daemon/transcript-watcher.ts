import chokidar from "chokidar";
import { stat, open } from "fs/promises";
import type { Database } from "bun:sqlite";
import { findSessionByAgentSessionId, upsertRollup, insertSample } from "../db/queries.ts";
import { log } from "../lib/logger.ts";
import { broadcast } from "./sse.ts";

interface Tailer {
  offset: number;
  sessionId: string | null;
  // uuid → subagent_type ("main" or the value of input.subagent_type from
  // Task/Agent tool_use blocks). Built incrementally as the transcript streams.
  // Sidechain messages inherit from the nearest known ancestor by walking
  // parentUuid.
  uuidToSubagent: Map<string, string>;
}

// First subagent_type found in any Task/Agent tool_use block on the message.
// Handles legacy "Task" and current "Agent" tool names.
function firstSubagentType(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const cb = c as Record<string, unknown>;
    if (cb.type !== "tool_use") continue;
    const name = String(cb.name ?? "");
    if (name !== "Task" && name !== "Agent") continue;
    const input = cb.input as Record<string, unknown> | undefined;
    const sub = input?.subagent_type;
    if (typeof sub === "string" && sub.length > 0) return sub;
  }
  return null;
}

// Resolve and cache this message's subagent_type. Strategy:
//  - non-sidechain message dispatching an Agent → "<subagent_type>" (any descendant inherits)
//  - non-sidechain message without dispatch       → "main"
//  - sidechain message                            → inherit from parentUuid in map, fall back to "main"
// Messages stream in topological order, so the parent is always recorded first.
function attributeMessage(
  uuid: string | undefined,
  parentUuid: string | undefined,
  isSidechain: boolean,
  message: Record<string, unknown> | undefined,
  map: Map<string, string>,
): string {
  let attr: string;
  if (!isSidechain) {
    attr = firstSubagentType(message) ?? "main";
  } else {
    attr = (parentUuid && map.get(parentUuid)) ?? "main";
  }
  if (uuid) map.set(uuid, attr);
  return attr;
}

export interface Watcher {
  stop(): Promise<void>;
}

export function startTranscriptWatcher(db: Database, roots: string[]): Watcher {
  // Per-watcher state — each call gets a fresh map to avoid cross-test leakage.
  const tailers = new Map<string, Tailer>();
  // Per-file serialization locks to prevent double-counting from concurrent chokidar fires.
  const locks = new Map<string, Promise<void>>();
  let stopped = false;

  const handleFile = async (path: string): Promise<void> => {
    if (stopped) return;
    if (!path.endsWith(".jsonl")) return;

    let t = tailers.get(path);
    if (!t) {
      t = { offset: 0, sessionId: null, uuidToSubagent: new Map() };
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
        if (stopped) return;

        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // silently skip malformed JSON
        }

        // Try to resolve session_id from multiple possible locations in the entry.
        // NOTE: If the first line in a batch doesn't carry session_id this lookup is
        // deferred to the next line that does — a known limitation, not restructured here.
        const agentSid: string | undefined =
          (typeof entry.session_id === "string" ? entry.session_id : undefined) ??
          (typeof entry.sessionId === "string" ? entry.sessionId : undefined) ??
          ((entry.message && typeof entry.message === "object")
            ? (entry.message as Record<string, unknown>).session_id as string | undefined
            : undefined);

        if (agentSid && !t.sessionId) {
          const sess = findSessionByAgentSessionId(db, agentSid);
          if (sess) t.sessionId = sess.id;
        }

        const message = entry.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
        const parentUuid = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
        const isSidechain = entry.isSidechain === true;

        // Maintain attribution map for every entry (cheap), so deep-nested
        // sidechain messages can inherit by parentUuid lookup.
        const subagent = attributeMessage(uuid, parentUuid, isSidechain, message, t.uuidToSubagent);

        if (usage && t.sessionId && !stopped) {
          const input = (usage.input_tokens as number) ?? 0;
          const output = (usage.output_tokens as number) ?? 0;
          const cacheRead = (usage.cache_read_input_tokens as number) ?? 0;
          const cacheWrite = (usage.cache_creation_input_tokens as number) ?? 0;

          upsertRollup(db, {
            session_id: t.sessionId,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cacheRead,
            cache_write_tokens: cacheWrite,
            cost_usd: 0,
            updated_at: Date.now(),
          });

          if (uuid) {
            // Prefer entry-level ISO timestamp; fall back to wall-clock now.
            const tsRaw = entry.timestamp;
            const ts = typeof tsRaw === "string"
              ? (Date.parse(tsRaw) || Date.now())
              : Date.now();
            insertSample(db, {
              session_id: t.sessionId,
              ts,
              input_tokens: input,
              output_tokens: output,
              cache_read_tokens: cacheRead,
              cache_write_tokens: cacheWrite,
              subagent_type: subagent === "main" ? null : subagent,
              message_uuid: uuid,
            });
          }

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
    async stop(): Promise<void> {
      stopped = true;
      await watcher.close();
      // Drain all in-flight chains so no handleFile call writes to db after stop() resolves.
      await Promise.allSettled(Array.from(locks.values()));
      locks.clear();
      tailers.clear();
    },
  };
}
