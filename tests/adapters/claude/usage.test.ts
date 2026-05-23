import { expect, test } from "bun:test";
import { parseUsage } from "../../../src/adapters/claude/usage.ts";

const SAMPLE = `
  Current session
  ████████████████▌                                  33% used
  Resets 12pm (America/Los_Angeles)

  Current week (all models)
  ████████████████████                               40% used
  Resets Apr 23 at 12pm (America/Los_Angeles)

  Current week (Sonnet only)
  ███▌                                               7% used
  Resets Apr 23 at 6pm (America/Los_Angeles)
`;

test("parseUsage extracts three buckets", () => {
  const snaps = parseUsage(SAMPLE);
  const get = (scope: string, key: string | null = null) =>
    snaps.find(s => s.scope === scope && (s.scope_key ?? null) === key);
  expect(get("session")?.used).toBe(33);
  expect(get("weekly")?.used).toBe(40);
  expect(get("model", "Sonnet")?.used).toBe(7);
});
