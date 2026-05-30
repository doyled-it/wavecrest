import { log } from "../lib/logger.ts";
import { join, resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { broadcastHeartbeat } from "./sse.ts";

export function serveUi(uiDir: string): (req: Request) => Response | null {
  return (req) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/ui")) return null;
    const rel = url.pathname.replace(/^\/ui\/?/, "") || "index.html";
    const file = resolve(join(uiDir, rel));
    // Path traversal guard: resolved path must be inside uiDir
    if (!file.startsWith(resolve(uiDir))) return new Response("not found", { status: 404 });
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    const body = readFileSync(file);
    const type = file.endsWith(".html") ? "text/html"
               : file.endsWith(".js")   ? "text/javascript"
               : file.endsWith(".css")  ? "text/css" : "application/octet-stream";
    // index.html references hashed asset names, so the assets themselves can
    // (and should) cache forever. But the HTML must NOT be cached or the
    // browser keeps loading stale bundles after the daemon updates.
    const cacheHeader = file.endsWith(".html")
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=31536000, immutable";
    return new Response(body, {
      headers: { "Content-Type": type, "Cache-Control": cacheHeader },
    });
  };
}

export interface HttpServer {
  stop(): void;
  port: number;
}

export function startHttpServer(
  handler: (req: Request) => Promise<Response> | Response,
  desiredPort = 17321,
): HttpServer {
  let port = desiredPort;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: handler,
        // Bun's default idleTimeout is 10s, which closes our SSE streams
        // constantly. 255 is Bun's max (seconds). We also broadcast an SSE
        // heartbeat comment every 15s so connections stay warm end-to-end.
        idleTimeout: 255,
      });
      const heartbeat = setInterval(broadcastHeartbeat, 15_000);
      log.info("http: listening", { port });
      return {
        stop: () => { clearInterval(heartbeat); server.stop(); },
        port,
      };
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw e;
    }
  }
  throw new Error("could not bind http server after 10 attempts");
}
