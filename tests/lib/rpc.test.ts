import { expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "../../src/lib/rpc.ts";

test("encode + decode roundtrip", () => {
  const dec = new FrameDecoder();
  const out: unknown[] = [];
  dec.push(encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" }));
  for (const msg of dec.drain()) out.push(msg);
  expect(out).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

test("partial frames buffer correctly", () => {
  const dec = new FrameDecoder();
  const buf = encodeFrame({ a: 1 });
  dec.push(buf.subarray(0, 3));
  dec.push(buf.subarray(3));
  expect(Array.from(dec.drain())).toEqual([{ a: 1 }]);
});
