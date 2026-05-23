// src/adapters/claude/index.ts
import type { AgentAdapter } from "../types.ts";
import { parseClaudeTranscript } from "./transcript.ts";
import { hookEventToSessionUpdate, claudeInstallInstructions } from "./hooks.ts";
import { claudeResumeCommand } from "./resume.ts";

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  parseTranscript: parseClaudeTranscript,
  hookEventToSessionUpdate,
  resumeCommand: claudeResumeCommand,
  installInstructions: claudeInstallInstructions,
};
