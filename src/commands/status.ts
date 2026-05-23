import { callDaemon } from "./hook.ts";
import type { Session } from "../types.ts";

export async function runStatus(): Promise<void> {
  const sessions = await callDaemon("listSessions", {}).catch(() => null) as Session[] | null;
  if (sessions === null) {
    console.error("wavecrest: daemon not running (try: wavecrest daemon)");
    process.exit(1);
  }
  if (sessions.length === 0) {
    console.log("(no active sessions)");
    return;
  }
  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(w("STATUS", 10) + w("KIND", 8) + w("BRANCH", 20) + "PATH");
  for (const s of sessions) {
    console.log(w(s.status, 10) + w(s.agent_kind, 8) + w(s.branch ?? "—", 20) + s.cwd);
  }
}
