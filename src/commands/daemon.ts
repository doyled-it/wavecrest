import { startDaemon } from "../daemon/index.ts";

export async function runDaemon(): Promise<void> {
  await startDaemon();
  await new Promise(() => {}); // run until killed
}
