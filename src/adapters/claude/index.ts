// src/adapters/claude/index.ts
import type { AgentAdapter } from "../types.ts";
import { parseClaudeTranscript } from "./transcript.ts";

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  parseTranscript: parseClaudeTranscript,
  hookEventToSessionUpdate() { return null; },
  resumeCommand() { return ["claude"]; },
  installInstructions() { return { hooks: {} }; },
};
