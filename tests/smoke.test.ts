import { expect, test } from "bun:test";

test("bun runtime sanity", () => {
  expect(typeof Bun.version).toBe("string");
});
