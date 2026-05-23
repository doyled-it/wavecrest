type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const envVal = process.env.WAVECREST_LOG;
const min: Level = (envVal === "debug" || envVal === "info" || envVal === "warn" || envVal === "error") ? envVal : "info";

function emit(level: Level, msg: string, extra?: unknown) {
  if (order[level] < order[min]) return;
  const ts = new Date().toISOString();
  const line = extra === undefined ? `${ts} ${level} ${msg}` : `${ts} ${level} ${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info:  (m: string, e?: unknown) => emit("info",  m, e),
  warn:  (m: string, e?: unknown) => emit("warn",  m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
