import { paths } from "../lib/paths.ts";
import { encodeFrame, FrameDecoder } from "../lib/rpc.ts";
import { connect } from "net";

export async function runHook(event: string): Promise<void> {
  // Read stdin payload (Claude Code pipes JSON to hooks)
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload: unknown = {};
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch {}
  }

  await callDaemon("hook", { kind: "claude", event, payload }).catch(() => {
    /* daemon down — silent */
  });
}

export function callDaemon(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(paths.sock, () => {
      sock.write(encodeFrame({ jsonrpc: "2.0", id: 1, method, params }));
    });
    const dec = new FrameDecoder();
    sock.on("data", (buf: Buffer) => {
      dec.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      for (const msg of dec.drain()) {
        const m = msg as { result?: unknown; error?: { message: string } };
        sock.destroy();
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
    sock.on("error", reject);
    sock.setTimeout(2000, () => {
      sock.destroy();
      reject(new Error("daemon RPC timeout"));
    });
  });
}
