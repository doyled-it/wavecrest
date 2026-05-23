// src/adapters/claude/index.ts
import type { AgentAdapter } from "../types.ts";

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  async *parseTranscript() {},
  hookEventToSessionUpdate() { return null; },
  resumeCommand() { return ["claude"]; },
  installInstructions() { return { hooks: {} }; },
};
