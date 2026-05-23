// 4-byte big-endian length prefix + UTF-8 JSON payload.

export function encodeFrame(msg: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

export class FrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  *drain(): IterableIterator<unknown> {
    while (this.buf.length >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, false);
      if (this.buf.length < 4 + len) return;
      const payload = this.buf.subarray(4, 4 + len);
      const text = new TextDecoder().decode(payload);
      // Advance the buffer BEFORE attempting to parse, so a bad frame doesn't
      // leave the decoder stuck on the same bytes on the next call.
      this.buf = this.buf.subarray(4 + len);
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        throw new Error(`rpc: malformed JSON in frame of ${len} bytes`);
      }
      yield msg;
    }
  }
}
