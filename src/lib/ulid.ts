const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTs = 0;
let lastRand: bigint = 0n;

export function ulid(): string {
  const ts = Date.now();
  if (ts <= lastTs) {
    // Clock unchanged or rolled back: stay monotonic by bumping the random component.
    // Leave lastTs at its current high-water mark.
    if (lastRand >= (1n << 80n) - 1n) throw new Error("ulid: random overflow");
    lastRand += 1n;
  } else {
    lastTs = ts;
    const seed = crypto.getRandomValues(new Uint8Array(10));
    let r = 0n;
    for (const b of seed) r = (r << 8n) | BigInt(b);
    lastRand = r;
  }
  let out = "";
  let t = BigInt(lastTs);
  for (let i = 9; i >= 0; i--) { out = ENC[Number(t & 0x1fn)]! + out; t >>= 5n; }
  let r = lastRand;
  let randStr = "";
  for (let i = 15; i >= 0; i--) { randStr = ENC[Number(r & 0x1fn)]! + randStr; r >>= 5n; }
  return out + randStr;
}
