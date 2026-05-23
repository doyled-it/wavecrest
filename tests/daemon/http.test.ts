import { describe, it, expect } from "bun:test";
import { startHttpServer } from "../../src/daemon/http.ts";

describe("startHttpServer", () => {
  it("binds a port and responds to /api/health", async () => {
    const server = startHttpServer(
      (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/health") return Response.json({ ok: true });
        return new Response("not found", { status: 404 });
      },
      // Use port 0 to let the OS pick a free port... Bun.serve doesn't support port 0,
      // so use a high unlikely port range instead.
      47321,
    );

    try {
      const port = server.port;
      expect(port).toBeGreaterThan(0);

      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as unknown;
      expect(body).toEqual({ ok: true });

      const notFound = await fetch(`http://127.0.0.1:${port}/missing`);
      expect(notFound.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  it("retries on a busy port", async () => {
    // Occupy the first port
    const first = startHttpServer((_req) => new Response("first"), 47400);
    const second = startHttpServer((_req) => new Response("second"), 47400);
    try {
      expect(second.port).toBe(47401);
    } finally {
      first.stop();
      second.stop();
    }
  });
});
