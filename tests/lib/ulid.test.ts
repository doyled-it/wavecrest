import { expect, test } from "bun:test";
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
