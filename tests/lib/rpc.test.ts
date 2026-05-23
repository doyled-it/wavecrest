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

test("drain throws on malformed frame and resumes on next valid frame", () => {
  const dec = new FrameDecoder();
  // Build a bogus 5-byte payload that isn't JSON, followed by a valid frame.
  const bad = new Uint8Array(9);
  new DataView(bad.buffer).setUint32(0, 5, false);
  bad.set([0xff, 0xff, 0xff, 0xff, 0xff], 4);
  dec.push(bad);
  expect(() => Array.from(dec.drain())).toThrow(/rpc: malformed JSON/);
  // Now push a valid frame — must parse without leftover state from the bad one.
  dec.push(encodeFrame({ ok: true }));
  expect(Array.from(dec.drain())).toEqual([{ ok: true }]);
});
