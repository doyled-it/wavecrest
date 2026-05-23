// src/adapters/claude/transcript.ts
import { readFile } from "fs/promises";
import type { NormalizedMessage } from "../../types.ts";

export async function* parseClaudeTranscript(path: string): AsyncIterable<NormalizedMessage> {
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;

    const ts = Date.parse(String(rec["timestamp"] ?? rec["ts"] ?? "")) || Date.now();
    const msg = (typeof rec["message"] === "object" && rec["message"] !== null)
      ? (rec["message"] as Record<string, unknown>)
      : rec;

    const role = String(msg["role"] ?? rec["type"] ?? "");
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    const normalized: NormalizedMessage = { role, ts };

    const content = msg["content"];
    if (typeof content === "string") {
      normalized.text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const c of content) {
        if (
          typeof c === "object" &&
          c !== null &&
          (c as Record<string, unknown>)["type"] === "text" &&
          typeof (c as Record<string, unknown>)["text"] === "string"
        ) {
          parts.push((c as Record<string, unknown>)["text"] as string);
        }
      }
      if (parts.length > 0) normalized.text = parts.join("\n");
    }

    if (typeof msg["model"] === "string") normalized.model = msg["model"];

    const usage = msg["usage"];
    if (typeof usage === "object" && usage !== null) {
      const u = usage as Record<string, unknown>;
      normalized.usage = {
        input_tokens: typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0,
        output_tokens: typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0,
        cache_read_tokens: typeof u["cache_read_input_tokens"] === "number" ? u["cache_read_input_tokens"] : 0,
        cache_creation_tokens: typeof u["cache_creation_input_tokens"] === "number" ? u["cache_creation_input_tokens"] : 0,
      };
    }

    yield normalized;
  }
}
