import { homedir } from "os";
import { join } from "path";

const ROOT = process.env.WAVECREST_HOME ?? join(homedir(), ".wavecrest");
export const paths = {
  root: ROOT,
  db: join(ROOT, "state.db"),
  sock: join(ROOT, "sock"),
  pid: join(ROOT, "daemon.pid"),
  port: join(ROOT, "port"),
  log: join(ROOT, "daemon.log"),
} as const;
