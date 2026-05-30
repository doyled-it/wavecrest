// src/adapters/claude/index.ts
import type { AgentAdapter } from "../types.ts";
import { parseClaudeTranscript } from "./transcript.ts";
import { hookEventToSessionUpdate, claudeInstallInstructions } from "./hooks.ts";
import { claudeResumeCommand } from "./resume.ts";
import { claudeAccountUsage, _resetMetaForTests } from "./usage.ts";

export const claudeAdapter: AgentAdapter & { resetAccountUsage(): void } = {
  kind: "claude",
  parseTranscript: parseClaudeTranscript,
  hookEventToSessionUpdate,
  resumeCommand: claudeResumeCommand,
  installInstructions: claudeInstallInstructions,
  accountUsage: claudeAccountUsage,
  // Force-respawn the hidden /usage meta-process. Called by the usage poller's
  // watchdog when polls time out repeatedly (the pty can wedge silently).
  resetAccountUsage: _resetMetaForTests,
};
