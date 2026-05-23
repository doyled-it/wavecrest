const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTs = 0;
let lastRand: bigint = 0n;

export function ulid(): string {
  let ts = Date.now();
  if (ts <= lastTs) {
    lastTs = ts;
    lastRand += 1n;
  } else {
    lastTs = ts;
    lastRand = BigInt.asUintN(80, BigInt("0x" + crypto.randomUUID().replace(/-/g, "").slice(0, 20)));
  }
  let out = "";
  let t = BigInt(ts);
  for (let i = 9; i >= 0; i--) { out = ENC[Number(t & 0x1fn)]! + out; t >>= 5n; }
  let r = lastRand;
  let randStr = "";
  for (let i = 15; i >= 0; i--) { randStr = ENC[Number(r & 0x1fn)]! + randStr; r >>= 5n; }
  return out + randStr;
}
