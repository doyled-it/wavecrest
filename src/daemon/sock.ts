import { existsSync, unlinkSync, chmodSync } from "fs";
import { FrameDecoder, encodeFrame } from "../lib/rpc.ts";
import { log } from "../lib/logger.ts";

export type RpcHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface SockServer {
  close(): void;
}

export function startSockServer(path: string, handler: RpcHandler): SockServer {
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }

  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        const dec = (socket.data as unknown as { dec: FrameDecoder }).dec;
        dec.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        void (async () => {
          for (const msg of dec.drain()) {
            const m = msg as { method: string; params?: unknown; id?: unknown };
            try {
              const result = await handler(m.method, m.params ?? null);
              socket.write(encodeFrame({ jsonrpc: "2.0", id: m.id, result }));
            } catch (e: unknown) {
              const message = e instanceof Error ? e.message : String(e);
              socket.write(encodeFrame({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } }));
            }
          }
        })();
      },
      open(socket) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (socket as any).data = { dec: new FrameDecoder() };
      },
      close() {},
      error(_, error) {
        log.warn("sock error", { error: String(error) });
      },
    },
  });

  chmodSync(path, 0o600);
  return {
    close() {
      server.stop();
      try { unlinkSync(path); } catch {}
    },
  };
}
