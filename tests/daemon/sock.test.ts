import { describe, it, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { connect } from "node:net";
import { startSockServer } from "../../src/daemon/sock.ts";
import { encodeFrame, FrameDecoder } from "../../src/lib/rpc.ts";

function rpcClient(sockPath: string): Promise<(method: string, params?: unknown) => Promise<unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    const decoder = new FrameDecoder();
    const pending = new Map<number, (result: unknown) => void>();
    let nextId = 1;

    sock.on("error", reject);
    sock.on("connect", () => {
      resolve(async (method: string, params: unknown = null) => {
        const id = nextId++;
        const frame = encodeFrame({ jsonrpc: "2.0", id, method, params });
        sock.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
        return new Promise((res, rej) => {
          pending.set(id, res);
          sock.once("error", rej);
        });
      });
    });

    sock.on("data", (chunk: Buffer) => {
      decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      for (const msg of decoder.drain()) {
        const m = msg as { id: number; result?: unknown; error?: { message: string } };
        const cb = pending.get(m.id);
        if (cb) {
          pending.delete(m.id);
          if (m.error != null) {
            // resolve with error object so callers can inspect
            cb({ __error: m.error });
          } else {
            cb(m.result);
          }
        }
      }
    });
  });
}

describe("startSockServer", () => {
  it("responds to ping RPC", async () => {
    const sockPath = join(tmpdir(), `wc-test-${Date.now()}.sock`);
    if (existsSync(sockPath)) unlinkSync(sockPath);

    const server = startSockServer(sockPath, async (method) => {
      if (method === "ping") return { ok: true };
      throw new Error(`unknown method: ${method}`);
    });

    try {
      const call = await rpcClient(sockPath);
      const result = await call("ping");
      expect(result).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it("returns an error response for unknown methods", async () => {
    const sockPath = join(tmpdir(), `wc-test-${Date.now()}.sock`);
    if (existsSync(sockPath)) unlinkSync(sockPath);

    const server = startSockServer(sockPath, async (method) => {
      if (method === "ping") return { ok: true };
      throw new Error(`unknown method: ${method}`);
    });

    try {
      const call = await rpcClient(sockPath);
      const result = await call("bogus") as { __error?: { message: string } };
      expect(result.__error?.message).toContain("unknown method");
    } finally {
      server.close();
    }
  });

  it("removes a stale socket file on startup", async () => {
    const sockPath = join(tmpdir(), `wc-test-stale-${Date.now()}.sock`);
    // Create a first server to leave a socket file behind
    const first = startSockServer(sockPath, async () => null);
    first.close();
    // The close() call removes the file, so write a fake stale one
    await Bun.write(sockPath, "stale");
    expect(existsSync(sockPath)).toBe(true);

    // Second server should remove the stale file and start clean
    const second = startSockServer(sockPath, async () => null);
    try {
      const call = await rpcClient(sockPath);
      const result = await call("ping");
      // handler returns null for everything — just checking we connected OK
      expect(result).toBeNull();
    } finally {
      second.close();
    }
  });
});
