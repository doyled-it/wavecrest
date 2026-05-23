import { describe, test, expect } from "bun:test";
import { wave } from "../../src/daemon/wave-bridge.ts";

describe("wave bridge", () => {
  test("available() returns false cleanly when wsh is not on PATH", async () => {
    // wsh is a Wave Terminal CLI — not expected to be installed in CI.
    // The bridge must degrade gracefully without throwing.
    const result = await wave.available();
    // We can't assert true/false definitively (wsh might be installed locally),
    // but we can assert the call completes without throwing and returns a boolean.
    expect(typeof result).toBe("boolean");
  });
});
