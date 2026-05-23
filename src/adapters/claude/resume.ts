// src/adapters/claude/resume.ts
import type { Session } from "../../types.ts";

export function claudeResumeCommand(session: Session): string[] {
  if (session.agent_session_id) return ["claude", "--resume", session.agent_session_id];
  return ["claude"];
}
