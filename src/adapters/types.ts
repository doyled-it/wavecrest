// src/adapters/types.ts
import type { AgentKind, NormalizedMessage, Session, SessionUpdate, UsageSnapshot, HookConfig } from "../types.ts";

export interface AgentAdapter {
  kind: AgentKind;
  parseTranscript(path: string): AsyncIterable<NormalizedMessage>;
  hookEventToSessionUpdate(eventName: string, payload: unknown): SessionUpdate | null;
  resumeCommand(session: Session): string[];
  installInstructions(wavecrestBinPath: string): HookConfig;
  accountUsage?(): Promise<UsageSnapshot[]>;
}
