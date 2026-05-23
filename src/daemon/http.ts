import { log } from "../lib/logger.ts";

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
      const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: handler });
      log.info("http: listening", { port });
      return { stop: () => server.stop(), port };
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
