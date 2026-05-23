import { callDaemon } from "./hook.ts";
import { wave } from "../daemon/wave-bridge.ts";
import { getAdapter } from "../adapters/registry.ts";
import type { Session } from "../types.ts";

export async function runRestore(): Promise<void> {
  if (!(await wave.available())) {
    console.error("wave (wsh) not detected; cannot restore");
    process.exit(1);
  }

  // listResumable returns fully-deserialized Session objects (daemon calls
  // listResumableSessions which applies rowToSession), so no manual JSON.parse
  // or boolean coercion is needed here.
  const sessions = await callDaemon("listResumable", {}) as Session[];

  for (const sess of sessions) {
    try {
      const adapter = getAdapter(sess.agent_kind);
      const argv = adapter.resumeCommand(sess);
      await wave.createBlock({
        tabName: sess.branch ?? sess.display_name ?? sess.id.slice(-8),
        cwd: sess.cwd, argv,
        envExtra: { WAVECREST_SESSION_ID: sess.id },
      });
      console.log(`restored ${sess.id}`);
    } catch (e) {
      console.error(`failed to restore ${sess.id}: ${(e as Error).message}`);
    }
  }

  console.log(`restored ${sessions.length} session(s)`);
}
