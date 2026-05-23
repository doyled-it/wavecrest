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

test("parseUsage handles ANSI-contaminated input", () => {
  const ansiSample = `
  Current session
  ████\x1b[0m  \x1b[31m33\x1b[0m% used
  Resets 12pm (America/Los_Angeles)

  Current week (all models)
  ████████████████████                               40% used
  Resets Apr 23 at 12pm (America/Los_Angeles)

  Current week (Sonnet only)
  ███▌                                               7% used
  Resets Apr 23 at 6pm (America/Los_Angeles)
`;
  const snaps = parseUsage(ansiSample);
  const get = (scope: string, key: string | null = null) =>
    snaps.find(s => s.scope === scope && (s.scope_key ?? null) === key);
  expect(get("session")?.used).toBe(33);
});

const SAMPLE_WITH_OPUS = `
  Current session
  ████████████████▌                                  33% used
  Resets 12pm (America/Los_Angeles)

  Current week (all models)
  ████████████████████                               40% used
  Resets Apr 23 at 12pm (America/Los_Angeles)

  Current week (Sonnet only)
  ███▌                                               7% used
  Resets Apr 23 at 6pm (America/Los_Angeles)

  Current week (Opus only)
  ██                                                 4% used
  Resets Apr 23 at 6pm (America/Los_Angeles)
`;

test("parseUsage handles the Opus bucket", () => {
  const snaps = parseUsage(SAMPLE_WITH_OPUS);
  expect(snaps).toHaveLength(4);
  const opus = snaps.find(s => s.scope === "model" && s.scope_key === "Opus");
  expect(opus?.used).toBe(4);
});
