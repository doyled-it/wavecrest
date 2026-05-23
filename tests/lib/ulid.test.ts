import { expect, spyOn, test } from "bun:test";
import { ulid } from "../../src/lib/ulid.ts";

test("ulid produces 26-char string", () => {
  const id = ulid();
  expect(id).toHaveLength(26);
});

test("ulids are monotonic within the same ms", () => {
  const a = ulid();
  const b = ulid();
  expect(a < b).toBe(true);
});

test("ulid stays monotonic across a simulated clock rollback", () => {
  const realNow = Date.now;
  const seq = [10_000, 9_500, 10_001, 10_001];
  let i = 0;
  const spy = spyOn(Date, "now").mockImplementation(() => seq[i++] ?? realNow());
  try {
    const ids = [ulid(), ulid(), ulid(), ulid()];
    for (let k = 1; k < ids.length; k++) {
      expect(ids[k - 1]! < ids[k]!).toBe(true);
    }
  } finally {
    spy.mockRestore();
  }
});
