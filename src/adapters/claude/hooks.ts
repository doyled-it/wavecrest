// src/adapters/claude/hooks.ts
import type { SessionUpdate, HookConfig } from "../../types.ts";

export function hookEventToSessionUpdate(eventName: string, payload: unknown): SessionUpdate | null {
  const p = (payload ?? {}) as Record<string, any>;
  const now = Date.now();
  const base: SessionUpdate = { last_active_at: now };
  if (p.session_id != null) base.agent_session_id = String(p.session_id);
  if (p.transcript_path != null) base.transcript_path = String(p.transcript_path);
  if (typeof p.cwd === "string" && p.cwd) base.cwd = p.cwd;

  switch (eventName) {
    case "SessionStart":
      return { ...base, status: "working" };
    case "PreToolUse": {
      const tool = String(p.tool_name ?? "");
      return { ...base, status: tool === "AskUserQuestion" ? "awaiting" : "working" };
    }
    case "PostToolUse":
      return { ...base, status: "working" };
    case "Notification": {
      const matcher = String(p.matcher ?? "");
      if (matcher === "permission_prompt" || matcher === "elicitation_dialog") {
        return { ...base, status: "awaiting" };
      }
      return base;
    }
    case "Stop":
      return { ...base, status: "idle" };
    case "SessionEnd":
      return { ...base, status: "finished" };
    default:
      return null;
  }
}

export function claudeInstallInstructions(wavecrestBin: string): HookConfig {
  const cmd = (event: string) => `${wavecrestBin} hook ${event}`;
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: cmd("SessionStart") }] }],
      PreToolUse:   [{ hooks: [{ type: "command", command: cmd("PreToolUse")   }] }],
      PostToolUse:  [{ hooks: [{ type: "command", command: cmd("PostToolUse")  }] }],
      Notification: [{ hooks: [{ type: "command", command: cmd("Notification") }] }],
      Stop:         [{ hooks: [{ type: "command", command: cmd("Stop")         }] }],
      SessionEnd:   [{ hooks: [{ type: "command", command: cmd("SessionEnd")   }] }],
    },
  };
}
